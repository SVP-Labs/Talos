import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, isNode, isSeq, LineCounter, parse, parseDocument } from 'yaml';
import { z } from 'zod';
import type { StepAt, ZizmorResult } from './zizmor.js';
import { CONFIG_FILE } from '../../config/load.js';
import type { WorkflowException } from '../../config/schema.js';
import type { Finding } from '../../core/finding.js';
import { beyond, expired } from '../supply/dates.js';

/** The longest a workflow exception may run: nothing is excepted forever. */
const MAX_EXCEPTION_DAYS = 365;

/** What the exceptions need besides zizmor's findings. */
export type ExceptionInputs = {
  readonly entries: readonly WorkflowException[];
  readonly now: Date;
  /** The step of a file's job at an index, by its `id` or else its `name`. */
  readonly stepName: (file: string, at: StepAt) => Promise<string | undefined>;
  /** `talos.yml` as written, so a finding points at its entry. */
  readonly configText: string;
};

/** A step as an exception names it: its `id`, or its `name` when it has none. */
const stepSchema = z
  .looseObject({ id: z.string().optional(), name: z.string().optional() })
  .transform((step) => (step.id === undefined || step.id === '' ? step.name : step.id));

const workflowSchema = z.looseObject({
  jobs: z.record(z.string(), z.looseObject({ steps: z.array(z.unknown()).optional() })),
});

/** The parsed workflow at `file`, or nothing when it can't be read as one. */
async function readWorkflow(root: string, file: string) {
  const text = await readFile(join(root, file), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = workflowSchema.safeParse(parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Reads each workflow once, and names the step at an index of a job. */
export function workflowSteps(root: string): ExceptionInputs['stepName'] {
  const files = new Map<string, ReturnType<typeof readWorkflow>>();
  return async (file, at) => {
    let workflow = files.get(file);
    if (workflow === undefined) {
      workflow = readWorkflow(root, file);
      files.set(file, workflow);
    }
    const step = (await workflow)?.jobs[at.job]?.steps?.[at.index];
    const name = stepSchema.safeParse(step);
    return name.success && name.data !== '' ? name.data : undefined;
  };
}

/** The 1-based line of each `exceptions.workflows` entry in `talos.yml`. */
export function entryLines(text: string): (number | undefined)[] {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  const exceptions = doc.get('exceptions', true);
  const workflows = isMap(exceptions) ? exceptions.get('workflows', true) : undefined;
  if (!isSeq(workflows)) return [];
  return workflows.items.map((item) =>
    isNode(item) && item.range ? counter.linePos(item.range[0]).line : undefined,
  );
}

function named(entry: WorkflowException): string {
  return `${entry.rule} in ${entry.file}, job ${entry.job}, step ${entry.step}`;
}

/** What is wrong with an entry itself, if anything, given whether it excepted a finding. */
function judge(entry: WorkflowException, used: boolean, now: Date): Finding[] {
  const key = `${entry.rule} ${entry.file} ${entry.job} ${entry.step}`;
  if (expired(entry, now)) {
    return [
      {
        rule: 'infra/exception-expired',
        key,
        policy: 'always',
        message: `The exception for ${named(entry)} expired on ${entry.expires}; fix the finding or renew the exception with a new reason.`,
      },
    ];
  }
  const found: Finding[] = [];
  if (!used) {
    found.push({
      rule: 'infra/exception-unused',
      key,
      message: `The exception for ${named(entry)} matches no finding; remove it.`,
    });
  }
  if (beyond(entry, now, MAX_EXCEPTION_DAYS)) {
    found.push({
      rule: 'infra/exception-too-long',
      key,
      message: `The exception for ${named(entry)} runs to ${entry.expires}; an exception may run for ${MAX_EXCEPTION_DAYS} days at most.`,
    });
  }
  return found;
}

/** Where a finding is, as an exception names it; nothing when it is in no step. */
type Place = {
  readonly rule: string;
  readonly file: string;
  readonly job: string;
  readonly step: string;
};

async function placeOf(result: ZizmorResult, inputs: ExceptionInputs): Promise<Place | undefined> {
  const { finding, step } = result;
  const file = finding.location?.file;
  if (file === undefined || step === undefined) return undefined;
  const name = await inputs.stepName(file, step);
  return name === undefined ? undefined : { rule: finding.rule, file, job: step.job, step: name };
}

const covers = (entry: WorkflowException, place: Place): boolean =>
  entry.rule === place.rule &&
  entry.file === place.file &&
  entry.job === place.job &&
  entry.step === place.step;

/**
 * zizmor's findings less those an unexpired `exceptions.workflows` entry matches on rule, file,
 * job and step, plus a finding for each entry that has expired, matched nothing or runs too long.
 */
export async function applyExceptions(
  results: readonly ZizmorResult[],
  inputs: ExceptionInputs,
): Promise<Finding[]> {
  const { entries, now } = inputs;
  const used = new Set<number>();
  const kept: Finding[] = [];
  for (const result of results) {
    const place = await placeOf(result, inputs);
    const matches = entries.flatMap((entry, index) =>
      place !== undefined && !expired(entry, now) && covers(entry, place) ? [index] : [],
    );
    for (const index of matches) used.add(index);
    if (matches.length === 0) kept.push(result.finding);
  }
  const lines = entryLines(inputs.configText);
  const own = entries.flatMap((entry, index) =>
    judge(entry, used.has(index), now).map((found): Finding => {
      const line = lines[index];
      return line === undefined ? found : { ...found, location: { file: CONFIG_FILE, line } };
    }),
  );
  return [...kept, ...own];
}

/** `talos.yml` at the checkout, or nothing when there is none to point at. */
export function configText(root: string): Promise<string> {
  return readFile(join(root, CONFIG_FILE), 'utf8').catch(() => '');
}

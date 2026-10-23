import { marker } from './talos-issues.js';
import { LABEL, looksClaimed, TYPE_LABELS, typeLabelsOf } from '../ticket/labels.js';
import { checkboxCount, hasContent, sections } from '../ticket/sections.js';

/**
 * Issue readiness: whether an issue is written well enough for anyone, person or agent, to pick
 * up. Pure; `readiness-job.ts` reads the issue and applies the verdict.
 */
export const MAX_CRITERIA = 5;

const HEADINGS: Readonly<Record<string, string>> = {
  goal: 'Goal',
  'acceptance criteria': 'Acceptance criteria',
  'out of scope': 'Out of scope',
  'affected areas': 'Affected areas',
  repro: 'Repro',
  'expected/actual': 'Expected / Actual',
};

const TICKET = ['goal', 'acceptance criteria', 'out of scope', 'affected areas'];

/**
 * An epic is split into tickets rather than implemented, so it needs no criteria or areas of
 * its own; a bug adds how to reproduce it and what should happen instead.
 */
export function requiredSections(types: readonly string[]): string[] {
  if (types.length === 1 && types[0] === LABEL.epic) return ['goal', 'out of scope'];
  return types.includes(LABEL.bug) ? [...TICKET, 'repro', 'expected/actual'] : TICKET;
}

/** An epic, and an issue that sets or changes a decision, must link a brief. */
export function needsBrief(labels: readonly string[]): boolean {
  return labels.includes(LABEL.epic) || labels.includes(LABEL.decision);
}

function validDate(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function trimSlashes(path: string): string {
  let start = path.startsWith('./') ? 2 : 0;
  let end = path.length;
  while (path[start] === '/') start += 1;
  while (end > start && path[end - 1] === '/') end -= 1;
  return path.slice(start, end);
}

/** What may stand right before a path in Markdown, or a GitHub link's `/blob/<ref>/`. */
function linkStarts(body: string, index: number): boolean {
  if (index === 0) return true;
  const before = body.slice(Math.max(0, index - 200), index);
  return (
    /[\s([<`"']$/.test(before) || /\/blob\/[^\s/]{1,100}\/$/.test(before) || before.endsWith('./')
  );
}

const BRIEF_NAME = /^\d{4}(\d{2})(\d{2})-[a-z0-9][a-z0-9-]{0,100}\.md(?![\w-]|\.\w)/;

/**
 * The briefs a body links: `<briefs>/<YYYYMMDD>-<slug>.md`, written as a path or as a link to
 * the file on GitHub. `briefsDir` is `talos.yml`'s `docs.briefs`.
 */
export function briefLinks(body: string, briefsDir: string): string[] {
  const dir = `${trimSlashes(briefsDir)}/`;
  const found: string[] = [];
  for (let at = body.indexOf(dir); at !== -1; at = body.indexOf(dir, at + dir.length)) {
    const start = at + dir.length;
    const name = BRIEF_NAME.exec(body.slice(start, start + 120));
    if (name === null || !validDate(Number(name[1]), Number(name[2]))) continue;
    const path = `${dir}${name[0]}`;
    if (linkStarts(body, at) && !found.includes(path)) found.push(path);
  }
  return found;
}

export type ReadinessInput = {
  readonly body: string;
  readonly labels: readonly string[];
  readonly briefsDir: string;
  /** Each brief path the body links, and whether it exists on the default branch. */
  readonly briefs: ReadonlyMap<string, boolean>;
};

export type Readiness = { readonly ready: boolean; readonly problems: readonly string[] };

function typeProblem(types: readonly string[]): string | undefined {
  if (types.length === 1) return undefined;
  const has = types.length === 0 ? 'it has none' : `it has ${types.join(', ')}`;
  return `exactly one type label (${TYPE_LABELS.join(', ')}); ${has}`;
}

function sectionProblems(body: string, required: readonly string[]): string[] {
  const found = sections(body);
  const problems: string[] = [];
  for (const key of required) {
    const heading = HEADINGS[key] ?? key;
    const text = found.get(key);
    if (text === undefined) problems.push(`a \`## ${heading}\` section`);
    else if (!hasContent(text)) problems.push(`something under \`## ${heading}\``);
  }
  const criteria = found.get('acceptance criteria');
  if (!required.includes('acceptance criteria') || !hasContent(criteria)) return problems;
  const count = checkboxCount(criteria ?? '');
  if (count === 0) problems.push('at least one `- [ ]` checkbox under Acceptance criteria');
  if (count > MAX_CRITERIA) {
    problems.push(`at most ${MAX_CRITERIA} acceptance criteria, not ${count}: split the issue`);
  }
  return problems;
}

function briefProblems(input: ReadinessInput): string[] {
  if (!needsBrief(input.labels)) return [];
  if (input.briefs.size === 0) {
    return [
      `a link to its brief, \`${input.briefsDir}/<YYYYMMDD>-<slug>.md\` ` +
        '(an epic, or an issue labelled `decision`, needs one)',
    ];
  }
  return [...input.briefs]
    .filter(([, exists]) => !exists)
    .map(([path]) => `its brief \`${path}\` on the default branch: it isn't there`);
}

export function judgeReadiness(input: ReadinessInput): Readiness {
  const types = typeLabelsOf(input.labels);
  const problems = [
    typeProblem(types),
    ...sectionProblems(input.body, requiredSections(types)),
    ...briefProblems(input),
  ].filter((p) => p !== undefined);
  return { ready: problems.length === 0, problems };
}

/**
 * The label changes a verdict implies. A ready issue becomes `status/ready` unless it is
 * claimed already or an epic, which is never claimed itself: its tickets are.
 */
export function readinessLabels(
  ready: boolean,
  labels: readonly string[],
): { add: string[]; remove: string[] } {
  const has = (label: string): boolean => labels.includes(label);
  if (!ready) {
    return {
      add: has(LABEL.needsSpec) ? [] : [LABEL.needsSpec],
      remove: has(LABEL.ready) ? [LABEL.ready] : [],
    };
  }
  const remove = [LABEL.needsSpec].filter(has);
  if (has(LABEL.epic)) return { add: [], remove: [...remove, ...[LABEL.ready].filter(has)] };
  const add = has(LABEL.ready) || looksClaimed(labels) ? [] : [LABEL.ready];
  return { add, remove };
}

/** The one comment readiness keeps on an issue, rewritten in place as the issue changes. */
export function readinessComment(problems: readonly string[]): string {
  if (problems.length === 0) {
    return `${marker('readiness')}\n**Ready.** This issue passes Talos's readiness check now.\n`;
  }
  return [
    marker('readiness'),
    "**Not ready yet.** Talos's readiness check needs:",
    '',
    ...problems.map((p) => `- ${p}`),
    '',
    'Edit the issue: the check runs again on every edit and updates this comment.',
    '',
  ].join('\n');
}

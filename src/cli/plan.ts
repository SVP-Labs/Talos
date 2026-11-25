import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Command, type Io, parse, required } from './io.js';
import { CONFIG_FILE, loadConfig } from '../config/load.js';
import { compactVerdict } from '../engine/gate.js';
import { adoptionFindings, type GatePlan, matrixOf, planFromEvent } from '../engine/plan.js';
import { textReport } from '../engine/report.js';
import { decide } from '../engine/verdict.js';
import { exec } from '../exec/exec.js';
import { git } from '../repo/git.js';
import { toSarif } from '../sarif/sarif.js';
import { ownVersion } from '../version/self.js';

function prNumber(io: Io): number | undefined {
  const match = /^refs\/pull\/(\d+)\//.exec(io.env.GITHUB_REF ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The verdict of a plan where nothing runs, as `talos verdict` writes it: the repository is not
 * adopted, which is a finding of the change, not a fault of the engine.
 */
async function writeUnadoptedVerdict(
  io: Io,
  gatePlan: GatePlan,
  paths: { json: string; sarif: string },
): Promise<void> {
  const decided = decide([], [], adoptionFindings(gatePlan));
  const version = ownVersion();
  const pr = prNumber(io);
  const compact = compactVerdict(decided, {
    talos: version,
    mode: gatePlan.mode,
    base: gatePlan.base,
    head: gatePlan.head,
    ...(io.env.GITHUB_REPOSITORY ? { repo: io.env.GITHUB_REPOSITORY } : {}),
    ...(pr === undefined ? {} : { pr }),
  });
  await writeFile(resolve(io.cwd, paths.json), `${JSON.stringify(compact, null, 2)}\n`);
  await writeFile(
    resolve(io.cwd, paths.sarif),
    `${JSON.stringify(toSarif(decided.findings, version))}\n`,
  );
  io.err(textReport(decided));
}

/**
 * `talos plan`: reads the gate's event and writes the plan and the jobs' matrix. Where neither the
 * base nor the head has `talos.yml`, nothing runs, and it writes the verdict too.
 */
export const plan: Command = async (argv, io) => {
  const { values } = parse(argv, {
    'event-name': { type: 'string' },
    event: { type: 'string' },
    out: { type: 'string', default: 'talos-plan.json' },
    json: { type: 'string', default: 'verdict.json' },
    sarif: { type: 'string', default: 'talos.sarif' },
  });
  const eventName = required(values['event-name'] ?? io.env.GITHUB_EVENT_NAME, 'event-name');
  const eventPath = required(values.event ?? io.env.GITHUB_EVENT_PATH, 'event');
  const payload: unknown = JSON.parse(await readFile(resolve(io.cwd, eventPath), 'utf8'));
  const config = existsSync(join(io.cwd, CONFIG_FILE)) ? await loadConfig(io.cwd) : undefined;
  const gatePlan = await planFromEvent(eventName, payload, git(exec, io.cwd), config);
  await writeFile(resolve(io.cwd, values.out), `${JSON.stringify(gatePlan, null, 2)}\n`);
  const adopted = gatePlan.adopted !== false;
  if (!adopted) await writeUnadoptedVerdict(io, gatePlan, values);
  const output = io.env.GITHUB_OUTPUT;
  if (output !== undefined) {
    await appendFile(output, `matrix=${JSON.stringify(matrixOf(gatePlan))}\nadopted=${adopted}\n`);
  }
  io.out(
    adopted
      ? `${gatePlan.mode}: ${gatePlan.commits.length} commit(s), ${gatePlan.runs.length} run(s)\n`
      : `${gatePlan.mode}: repository not adopted: no ${CONFIG_FILE} at the base or the head\n`,
  );
  return 0;
};

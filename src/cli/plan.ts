import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Command, parse, required } from './io.js';
import { loadConfig } from '../config/load.js';
import { type GatePlan, planFromEvent } from '../engine/plan.js';
import { exec } from '../exec/exec.js';
import { git } from '../repo/git.js';

const RUNNERS = {
  linux: 'ubuntu-latest',
  windows: 'windows-latest',
  macos: 'macos-latest',
} as const;

/**
 * The run job's matrix: one entry per run, carrying what the gate sets up before Talos runs,
 * `php` (the minor, or empty) and `langs` (comma-separated), read at the run's own commit.
 */
function matrixOf(gatePlan: GatePlan) {
  return {
    include: gatePlan.runs.map((r) => ({
      sha: r.sha,
      tiers: r.tiers.join(','),
      os: r.os,
      runner: RUNNERS[r.os],
      langs: r.langs.join(','),
      php: r.php,
    })),
  };
}

/** `talos plan`: reads the gate's event and writes the plan and the jobs' matrix. */
export const plan: Command = async (argv, io) => {
  const { values } = parse(argv, {
    'event-name': { type: 'string' },
    event: { type: 'string' },
    out: { type: 'string', default: 'talos-plan.json' },
  });
  const eventName = required(values['event-name'] ?? io.env.GITHUB_EVENT_NAME, 'event-name');
  const eventPath = required(values.event ?? io.env.GITHUB_EVENT_PATH, 'event');
  const payload: unknown = JSON.parse(await readFile(resolve(io.cwd, eventPath), 'utf8'));
  const config = await loadConfig(io.cwd);
  const gatePlan = await planFromEvent(eventName, payload, git(exec, io.cwd), config);
  await writeFile(resolve(io.cwd, values.out), `${JSON.stringify(gatePlan, null, 2)}\n`);
  const output = io.env.GITHUB_OUTPUT;
  if (output !== undefined) {
    await appendFile(output, `matrix=${JSON.stringify(matrixOf(gatePlan))}\n`);
  }
  io.out(
    `${gatePlan.mode}: ${gatePlan.commits.length} commit(s), ${gatePlan.runs.length} run(s)\n`,
  );
  return 0;
};

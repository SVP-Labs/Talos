import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { type Command, parse, required } from './io.js';
import { loadConfig } from '../config/load.js';
import { planFromEvent } from '../engine/plan.js';
import { exec } from '../exec/exec.js';
import { git } from '../repo/git.js';

const RUNNERS = {
  linux: 'ubuntu-latest',
  windows: 'windows-latest',
  macos: 'macos-latest',
} as const;

/** `talos plan`: reads the gate's event and writes the plan and the jobs' matrix. */
export const plan: Command = async (argv, io) => {
  const { values } = parse(argv, {
    'event-name': { type: 'string' },
    event: { type: 'string' },
    out: { type: 'string', default: 'talos-plan.json' },
  });
  const eventName = required(values['event-name'] ?? io.env.GITHUB_EVENT_NAME, 'event-name');
  const eventPath = required(values.event ?? io.env.GITHUB_EVENT_PATH, 'event');
  const payload: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
  const config = await loadConfig(io.cwd);
  const gatePlan = await planFromEvent(eventName, payload, git(exec, io.cwd), config);
  await writeFile(values.out, `${JSON.stringify(gatePlan, null, 2)}\n`);
  const matrix = {
    include: gatePlan.runs.map((r) => ({
      sha: r.sha,
      tiers: r.tiers.join(','),
      os: r.os,
      runner: RUNNERS[r.os],
    })),
  };
  const output = io.env.GITHUB_OUTPUT;
  if (output !== undefined) await appendFile(output, `matrix=${JSON.stringify(matrix)}\n`);
  io.out(
    `${gatePlan.mode}: ${gatePlan.commits.length} commit(s), ${gatePlan.runs.length} run(s)\n`,
  );
  return 0;
};

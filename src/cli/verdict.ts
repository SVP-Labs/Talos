import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Command, type Io, parse } from './io.js';
import { loadConfig } from '../config/load.js';
import { parseRunResult, type RunResult } from '../core/result.js';
import { commitFindings, comparisonsFor, compactVerdict } from '../engine/gate.js';
import { gatePlanSchema } from '../engine/plan.js';
import { annotations, markdownSummary, textReport } from '../engine/report.js';
import { decide, exitCode } from '../engine/verdict.js';
import { exec } from '../exec/exec.js';
import { git } from '../repo/git.js';
import { toSarif } from '../sarif/sarif.js';
import { ownVersion } from '../version/self.js';

async function readResults(directory: string): Promise<RunResult[]> {
  const names = (await readdir(directory, { recursive: true })).filter((n) => n.endsWith('.json'));
  return Promise.all(
    names.map(async (name) => parseRunResult(await readFile(join(directory, name), 'utf8'))),
  );
}

function prNumber(io: Io): number | undefined {
  const match = /^refs\/pull\/(\d+)\//.exec(io.env.GITHUB_REF ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** `talos verdict`: judges the gate's runs, writes SARIF and the compact verdict, annotates. */
export const verdict: Command = async (argv, io) => {
  const { values } = parse(argv, {
    plan: { type: 'string', default: 'talos-plan.json' },
    results: { type: 'string', default: 'talos-results' },
    sarif: { type: 'string', default: 'talos.sarif' },
    json: { type: 'string', default: 'verdict.json' },
  });
  const plan = gatePlanSchema.parse(JSON.parse(await readFile(values.plan, 'utf8')));
  const repo = git(exec, io.cwd);
  const config = await loadConfig(io.cwd);
  const results = await readResults(values.results);
  const decided = decide(
    results,
    await comparisonsFor(repo, plan),
    await commitFindings(repo, plan, config),
  );
  const version = ownVersion();
  await writeFile(values.sarif, `${JSON.stringify(toSarif(decided.findings, version))}\n`);
  const pr = prNumber(io);
  const compact = compactVerdict(decided, {
    talos: version,
    mode: plan.mode,
    base: plan.base,
    head: plan.head,
    ...(io.env.GITHUB_REPOSITORY ? { repo: io.env.GITHUB_REPOSITORY } : {}),
    ...(pr === undefined ? {} : { pr }),
  });
  await writeFile(values.json, `${JSON.stringify(compact, null, 2)}\n`);
  io.out(annotations(decided));
  io.err(textReport(decided));
  const summary = io.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) await appendFile(summary, markdownSummary(decided));
  const output = io.env.GITHUB_OUTPUT;
  if (output !== undefined) await appendFile(output, `engine_error=${decided.faults.length > 0}\n`);
  return exitCode(decided);
};

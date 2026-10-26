import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../../config/load.js';
import type { CheckContext } from '../../../core/check.js';
import { silentLogger } from '../../../core/log.js';
import type { Exec, ExecResult } from '../../../exec/exec.js';
import { repoFacts } from '../../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../../testing/engine.js';
import type { Tools } from '../../../tools/tools.js';

export type Call = { readonly command: string; readonly args: readonly string[] };

/** Tools that resolve to `/tools/<name>` without fetching anything. */
const fakeTools: Tools = {
  path: (name) => Promise.resolve(`/tools/${name}`),
  version: () => '1.0.0',
};

/** An exec that records each call and answers with what `respond` returns. */
export function recording(respond: (call: Call) => ExecResult | Promise<ExecResult>): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = async (command, args) => {
    const call = { command, args };
    calls.push(call);
    return respond(call);
  };
  return { exec, calls };
}

export const ok = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: '' });

/** A check context over a temporary repository holding `files`, every one tracked. */
export async function infraContext(
  files: Readonly<Record<string, string>>,
  exec: Exec,
  tools: Tools = fakeTools,
): Promise<CheckContext> {
  const root = await tempRepo(files);
  return {
    facts: repoFacts(Object.keys(files), []),
    config: parseConfig(MINIMAL_CONFIG),
    side: 'alone',
    tiers: ['commit', 'head'],
    root,
    sha: '0'.repeat(40),
    exec,
    tools,
    scratch: await mkdtemp(join(tmpdir(), 'talos-infra-')),
    log: silentLogger,
    os: 'linux',
    memo: (_key, compute) => compute(),
  };
}

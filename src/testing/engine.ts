import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import { silentLogger } from '../core/log.js';
import type { Pack } from '../core/pack.js';
import type { Engine, RunPlan } from '../engine/run.js';
import { exec } from '../exec/exec.js';
import { repoFacts } from '../repo/facts.js';
import type { Tools } from '../tools/tools.js';

/** A directory holding the given files, for tests. */
export async function tempRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talos-test-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

export const noTools: Tools = {
  path: (name) => Promise.reject(new Error(`no tool ${name} in tests`)),
  version: () => '0.0.0',
};

export function testEngine(packs: readonly Pack[], tools: Tools = noTools): Engine {
  return { exec, tools, log: silentLogger, version: '0.0.0-test', packs };
}

export const MINIMAL_CONFIG = 'name: Test\nprefix: T\n';

export function testPlan(
  root: string,
  files: readonly string[],
  config: TalosConfig = parseConfig(MINIMAL_CONFIG),
): RunPlan {
  return {
    root,
    sha: '0'.repeat(40),
    tiers: ['commit', 'head'],
    os: 'linux',
    side: 'alone',
    config,
    facts: repoFacts(files, config.exclude),
  };
}

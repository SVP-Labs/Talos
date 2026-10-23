import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { alertOf, type RuntimeAlert } from './sweep.js';
import { runtimePack } from '../checks/runtime/index.js';
import { parseConfig } from '../config/load.js';
import type { TalosConfig } from '../config/schema.js';
import { silentLogger } from '../core/log.js';
import type { Pack } from '../core/pack.js';
import { type Engine, runChecks } from '../engine/run.js';
import { exec } from '../exec/exec.js';
import { repoFacts } from '../repo/facts.js';
import { createTools } from '../tools/lock.js';
import { ownVersion } from '../version/self.js';

/**
 * How the sweep asks the runtime pack about a repository it never checks out: the declaring files
 * are read through the API, written into an empty directory, and the pack's own checks run there,
 * exactly as they run in the gate. Nothing from the repository is executed: the checks parse
 * files and ask the vendors' feeds.
 */
type Assessment = { readonly alerts: readonly RuntimeAlert[]; readonly errors: number };

/** Files by repository-relative path. */
export type RuntimeAssessor = (files: ReadonlyMap<string, string>) => Promise<Assessment>;

const FALLBACK_CONFIG = 'name: sweep\nprefix: S\n';

function configOf(text: string | undefined): TalosConfig {
  if (text !== undefined) {
    try {
      return parseConfig(text);
    } catch {
      // An invalid talos.yml fails the repository's own gate; the sweep still checks runtimes.
    }
  }
  return parseConfig(FALLBACK_CONFIG);
}

/** A path inside `root`, or `undefined` for one that would leave it. */
export function inside(root: string, path: string): string | undefined {
  const target = resolve(root, path);
  const rel = relative(root, target);
  return rel === '' || rel.startsWith('..') || rel.split(sep).includes('..') ? undefined : target;
}

async function writeFiles(root: string, files: ReadonlyMap<string, string>): Promise<string[]> {
  const written: string[] = [];
  for (const [path, text] of files) {
    const target = inside(root, path);
    if (target === undefined) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
    written.push(path);
  }
  return written;
}

/** The runtime pack's checks as an assessor; another pack can stand in for tests. */
export function packAssessor(pack: Pack = runtimePack): RuntimeAssessor {
  return async (files) => {
    const root = await mkdtemp(join(tmpdir(), 'talos-sweep-'));
    try {
      const written = await writeFiles(root, files);
      const config = configOf(files.get('talos.yml'));
      const engine: Engine = {
        exec,
        tools: createTools(exec, silentLogger),
        log: silentLogger,
        version: ownVersion(),
        packs: [pack],
      };
      const result = await runChecks(engine, {
        root,
        sha: '0'.repeat(40),
        tiers: ['commit', 'head'],
        os: 'linux',
        side: 'alone',
        config,
        facts: repoFacts(written, config.exclude),
      });
      return {
        alerts: result.outcomes.flatMap((o) => o.findings.flatMap((f) => alertOf(f) ?? [])),
        errors: result.outcomes.filter((o) => o.status === 'error').length,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
}

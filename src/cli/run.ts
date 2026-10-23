import { writeFile } from 'node:fs/promises';
import { type Command, parse, UsageError } from './io.js';
import type { Os, Tier } from '../core/check.js';
import { changesBetween, runAt } from '../engine/local.js';
import type { Side } from '../engine/run.js';
import { createEngine } from '../engine/session.js';
import { git, revParse } from '../repo/git.js';

const TIERS = new Set<string>(['commit', 'head']);
const OSES = new Set<string>(['linux', 'windows', 'macos']);

export function currentOs(platform: NodeJS.Platform = process.platform): Os {
  if (platform === 'win32') return 'windows';
  return platform === 'darwin' ? 'macos' : 'linux';
}

function tiersOf(value: string): Tier[] {
  const tiers = value.split(',').filter(Boolean);
  if (tiers.length === 0 || tiers.some((t) => !TIERS.has(t))) {
    throw new UsageError(`--tiers takes commit,head`);
  }
  return tiers as Tier[];
}

function sideOf(range: string | undefined, side: string | undefined): Side {
  if (range === undefined) return 'alone';
  return side === 'base' ? 'base' : 'head';
}

/**
 * `talos run`: the checks of some tiers at the checkout in the working directory, as one job of
 * the gate runs them. `--range base..head` says what the run is compared within, and `--side`
 * which end this checkout is.
 */
export const run: Command = async (argv, io) => {
  const { values } = parse(argv, {
    tiers: { type: 'string', default: 'commit,head' },
    os: { type: 'string' },
    range: { type: 'string' },
    side: { type: 'string' },
    only: { type: 'string' },
    out: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  });
  const os = values.os ?? currentOs();
  if (!OSES.has(os)) throw new UsageError(`--os takes linux, windows or macos`);
  const engine = createEngine(values.verbose);
  const repo = git(engine.exec, io.cwd);
  const sha = await revParse(repo, 'HEAD');
  const [from, to] = values.range?.split('..') ?? [];
  const side = sideOf(values.range, values.side);
  const changes =
    from === undefined || to === undefined ? undefined : await changesBetween(repo, from, to);
  const result = await runAt(engine, {
    root: io.cwd,
    sha,
    tiers: tiersOf(values.tiers),
    os: os as Os,
    side,
    ...(changes ? { changes } : {}),
    ...(values.only ? { only: values.only.split(',') } : {}),
  });
  const text = `${JSON.stringify(result)}\n`;
  if (values.out === undefined) io.out(text);
  else await writeFile(values.out, text);
  return 0;
};

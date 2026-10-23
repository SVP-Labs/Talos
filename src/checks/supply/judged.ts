import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseText, changeTo } from './base.js';
import { type Locked, lockfiles, parseLockfile } from './lockfiles/index.js';
import type { ApplyContext, CheckContext } from '../../core/check.js';

/** One lockfile, and the locked versions this side of a run reports on. */
export type Judged = {
  readonly path: string;
  readonly judged: readonly Locked[];
  /** For each package name, the versions the base commit had that head no longer has. */
  readonly replaced: ReadonlyMap<string, readonly string[]>;
};

const NOTHING_REPLACED: ReadonlyMap<string, readonly string[]> = new Map();

const identity = (locked: Locked): string => `${locked.ecosystem}:${locked.name}@${locked.version}`;

/** A version npm installs in several places is judged once. */
function unique(locked: readonly Locked[]): Locked[] {
  const seen = new Map<string, Locked>();
  for (const entry of locked) if (!seen.has(identity(entry))) seen.set(identity(entry), entry);
  return [...seen.values()];
}

/** The versions of each package base had and head dropped: what head's versions replace. */
export function replacedVersions(
  head: readonly Locked[],
  base: readonly Locked[],
): Map<string, string[]> {
  const kept = new Set(head.map(identity));
  const replaced = new Map<string, string[]>();
  for (const locked of base.filter((b) => !kept.has(identity(b)))) {
    replaced.set(locked.name, [...(replaced.get(locked.name) ?? []), locked.version]);
  }
  return replaced;
}

type Side = Pick<ApplyContext, 'side' | 'changes'>;

/**
 * Which locked versions a side judges. Alone, every one. In a comparison, head judges what it
 * added and base nothing, so a finding is new exactly when the change added the version; when
 * the diff can't rebuild the base lockfile, both sides judge everything and the comparison
 * sorts it out.
 */
export function judge(side: Side, path: string, text: string): Judged {
  const locked = unique(parseLockfile(path, text));
  const all = { path, judged: locked, replaced: NOTHING_REPLACED };
  if (side.side === 'alone' || side.changes === undefined) return all;
  const change = changeTo(side.changes, path);
  if (change === undefined) return { path, judged: [], replaced: NOTHING_REPLACED };
  const base = baseText(text, change);
  if (!base.known) return all;
  if (side.side === 'base') return { path, judged: [], replaced: NOTHING_REPLACED };
  const before = base.text === undefined ? [] : parseLockfile(path, base.text);
  const had = new Set(before.map(identity));
  return {
    path,
    judged: locked.filter((l) => !had.has(identity(l))),
    replaced: replacedVersions(locked, before),
  };
}

/** Every tracked lockfile, judged once per run and shared by the checks that read them. */
export async function judgedLockfiles(ctx: CheckContext): Promise<readonly Judged[]> {
  return ctx.memo('supply/judged-lockfiles', async () =>
    Promise.all(
      lockfiles(ctx.facts).map(async (path) =>
        judge(ctx, path, await readFile(join(ctx.root, path), 'utf8')),
      ),
    ),
  );
}

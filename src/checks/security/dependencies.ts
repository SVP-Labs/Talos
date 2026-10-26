import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { allowedLicences } from './licences.js';
import { osvIgnores, osvLockfiles } from './osv-config.js';
import { dependencyFindings, type LockedLookup, parseOsvReport } from './osv.js';
import {
  APPLIES,
  type ApplyContext,
  type Applicability,
  type Check,
  type CheckContext,
  EngineError,
  skip,
} from '../../core/check.js';
import { sameName } from '../supply/advisories.js';
import { type Locked, LOCKFILE_NAMES, readLockfile } from '../supply/lockfiles/index.js';

/** osv-scanner: 0 nothing found, 1 something found, 128 no package in any lockfile. */
const READ_EXITS = new Set([0, 1, 128]);

function hasOsvLockfile(ctx: ApplyContext): Applicability {
  return osvLockfiles(ctx.facts).length > 0 ? APPLIES : skip('the repository has no lockfile');
}

/** Each lockfile Talos reads itself, indexed so a scanned package finds its entry. */
async function lockedLookup(ctx: CheckContext, files: readonly string[]): Promise<LockedLookup> {
  const readable = files.filter((file) => LOCKFILE_NAMES.includes(posix.basename(file)));
  const entries = new Map<string, readonly Locked[]>();
  for (const file of readable) entries.set(file, await readLockfile(ctx.root, file));
  return (lockfile, name, version) =>
    entries
      .get(lockfile)
      ?.find(
        (locked) => locked.version === version && sameName(locked.ecosystem, locked.name, name),
      );
}

async function scan(ctx: CheckContext, files: readonly string[]): Promise<string | undefined> {
  const tool = await ctx.tools.path('osv-scanner');
  const config = join(ctx.scratch, 'osv-scanner.toml');
  const output = join(ctx.scratch, 'osv.json');
  await writeFile(config, osvIgnores(ctx.config));
  const args = [
    'scan',
    'source',
    '--format=json',
    `--output-file=${output}`,
    '--verbosity=error',
    '--no-call-analysis=all',
    `--config=${config}`,
    `--licenses=${allowedLicences(ctx.config).join(',')}`,
    ...files.flatMap((file) => ['-L', file]),
  ];
  const result = await ctx.exec(tool, args, { cwd: ctx.root });
  if (!READ_EXITS.has(result.code)) {
    const detail = result.stderr.trim().split('\n').at(-1) ?? '';
    throw new EngineError(`osv-scanner exited ${result.code}: ${detail}`);
  }
  return result.code === 128 ? undefined : readFile(output, 'utf8');
}

/**
 * osv-scanner over every lockfile: each advisory is a finding, a high or critical one failing
 * every change until it is fixed or an unexpired exception covers it; each licence outside the
 * org's allowlist and the project's additions is a finding too.
 */
export function dependenciesCheck(): Check {
  return {
    id: 'security/dependencies',
    tier: 'head',
    scope: 'repo',
    title: 'osv-scanner: known vulnerabilities and licences in every lockfile',
    applies: hasOsvLockfile,
    run: async (ctx) => {
      const files = osvLockfiles(ctx.facts);
      const report = await scan(ctx, files);
      if (report === undefined) return [];
      const packages = parseOsvReport(report, ctx.root);
      const lookup = await lockedLookup(ctx, files);
      return dependencyFindings(packages, lookup, allowedLicences(ctx.config));
    },
  };
}

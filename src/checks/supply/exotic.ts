import { hasLockfile } from './deps.js';
import { type Locked, lockfiles, readLockfile } from './lockfiles/index.js';
import type { Check } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const KINDS: Readonly<Record<'git' | 'url', string>> = {
  git: 'a git repository',
  url: 'a tarball or URL',
};

/** A dependency from git or a URL, anywhere in a lockfile's tree. */
function exoticFindings(path: string, locked: readonly Locked[]): Finding[] {
  return locked.flatMap((entry): Finding[] => {
    const source = entry.source;
    if (source.kind !== 'git' && source.kind !== 'url') return [];
    return [
      {
        rule: 'supply/exotic-source',
        key: `${entry.name} ${source.from}`,
        message:
          `${entry.name} ${entry.version} in ${path} comes from ${KINDS[source.kind]} ` +
          `(${source.from}), not a registry; depend on a published release instead.`,
      },
    ];
  });
}

export function exoticCheck(): Check {
  return {
    id: 'supply/exotic',
    tier: 'head',
    scope: 'repo',
    title: 'no git or tarball dependency anywhere in the tree',
    applies: hasLockfile,
    run: async (ctx) => {
      const found = await Promise.all(
        lockfiles(ctx.facts).map(async (path) =>
          exoticFindings(path, await readLockfile(ctx.root, path)),
        ),
      );
      return found.flat();
    },
  };
}

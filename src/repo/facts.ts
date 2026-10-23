import picomatch from 'picomatch';

export type RepoFacts = {
  /** Tracked files, repository-relative, minus `talos.yml`'s `exclude`. */
  readonly files: readonly string[];
  /** Files matching any of the globs. */
  matching(...globs: string[]): string[];
  has(...globs: string[]): boolean;
};

function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/** An `exclude` entry names a directory, a file or a glob. */
export function excludeMatcher(entries: readonly string[]): (path: string) => boolean {
  if (entries.length === 0) return () => false;
  const globs = entries.flatMap((entry) => {
    const trimmed = trimTrailingSlashes(entry);
    return [trimmed, `${trimmed}/**`];
  });
  return picomatch(globs, { dot: true });
}

export function repoFacts(tracked: readonly string[], exclude: readonly string[]): RepoFacts {
  const excluded = excludeMatcher(exclude);
  const files = tracked.filter((file) => !excluded(file));
  const matching = (...globs: string[]): string[] => {
    const isMatch = picomatch(globs, { dot: true });
    return files.filter((file) => isMatch(file));
  };
  return {
    files,
    matching,
    has: (...globs) => matching(...globs).length > 0,
  };
}

/** Files under a component's root, with the root's prefix kept. */
export function underRoot(files: readonly string[], root: string): string[] {
  if (root === '.' || root === '') return [...files];
  const prefix = `${trimTrailingSlashes(root)}/`;
  return files.filter((file) => file.startsWith(prefix));
}

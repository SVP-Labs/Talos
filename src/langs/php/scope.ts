import { readdir } from 'node:fs/promises';
import { componentDir, isCheckedPhp, type Place } from './paths.js';

/**
 * What a whole-project analysis reads, relative to the component's root. PHPStan and deptrac
 * are given directories, since PHPStan reports dead code only when it walked a directory.
 */
export type Scope = {
  /** Directories holding tracked PHP, and tracked PHP files at the root; `.` when only those. */
  readonly paths: readonly string[];
  /** PHP files under `paths` that Talos doesn't check (untracked, excluded, Blade, vendored). */
  readonly excluded: readonly string[];
  /** Directories under `paths` with nothing Talos checks. */
  readonly excludedDirs: readonly string[];
};

/** The top-level directories that hold the files, and the files at the root. */
export function topLevel(files: readonly string[]): { dirs: string[]; rootFiles: string[] } {
  const dirs = new Set<string>();
  const rootFiles: string[] = [];
  for (const file of files) {
    const slash = file.indexOf('/');
    if (slash < 0) rootFiles.push(file);
    else dirs.add(file.slice(0, slash));
  }
  return { dirs: [...dirs].sort((a, b) => a.localeCompare(b)), rootFiles };
}

/** Found PHP files (relative to the component) that aren't among the checked ones. */
export function unchecked(found: readonly string[], checked: ReadonlySet<string>): string[] {
  return found
    .filter((file) => file.endsWith('.php') && !checked.has(file))
    .sort((a, b) => a.localeCompare(b));
}

async function phpUnder(base: string, dir: string): Promise<string[]> {
  const entries = await readdir(`${base}/${dir}`, { recursive: true });
  return entries
    .map((entry) => `${dir}/${entry.replaceAll('\\', '/')}`)
    .filter((path) => path.endsWith('.php'));
}

/** Only root-level files are checked: every directory is left out whole. */
async function rootOnly(base: string, checked: ReadonlySet<string>): Promise<Scope> {
  const entries = await readdir(base, { withFileTypes: true });
  return {
    paths: ['.'],
    excluded: unchecked(
      entries.filter((e) => e.isFile()).map((e) => e.name),
      checked,
    ),
    excludedDirs: entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}

/** The scope of an analysis of `files` (component-relative, all checked PHP). */
export async function scopeFor(
  place: Pick<Place, 'root' | 'component'>,
  files: readonly string[],
): Promise<Scope> {
  const base = componentDir(place);
  const checked = new Set(files.filter((file) => isCheckedPhp(file)));
  const { dirs, rootFiles } = topLevel([...checked]);
  if (dirs.length === 0) return rootOnly(base, checked);
  const found = (await Promise.all(dirs.map(async (dir) => phpUnder(base, dir)))).flat();
  return { paths: [...dirs, ...rootFiles], excluded: unchecked(found, checked), excludedDirs: [] };
}

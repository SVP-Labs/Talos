import { parseDoctests } from './doctests.js';
import type { Case } from './junit.js';
import { isLibrary, rootDir, type Workspace } from './metadata.js';
import { relativeTo } from './paths.js';
import { type Bound, cargo, HOUR, tail } from './run.js';
import { componentDir } from '../../core/component.js';

export type DocRun = {
  readonly code: number;
  readonly output: string;
  readonly cases: readonly Case[];
  /** The directory the cases' files are relative to: the component's. */
  readonly base: string;
};

type Local = { readonly files?: readonly string[]; readonly full: readonly string[] };

function under(path: string, dir: string): boolean {
  return dir === '' || path.startsWith(`${dir}/`);
}

/**
 * libtest's arguments for the doctests a request runs, or undefined for none: the rerun's files
 * that lie in a library with doctests, or everything but `tests.full`. A doctest's name starts
 * with its file relative to the workspace root, which libtest's filters match.
 */
export function doctestFilters(
  ws: Workspace,
  local: Local,
  suite: 'commit' | 'all',
  toWorkspace: (path: string) => string,
): string[] | undefined {
  const libraries = ws.packages
    .flatMap((pkg) => pkg.targets)
    .filter((t) => isLibrary(t) && t.doctest);
  if (libraries.length === 0) return undefined;
  if (local.files !== undefined) {
    const files = local.files.filter(
      (file) => file.endsWith('.rs') && libraries.some((lib) => under(file, rootDir(lib))),
    );
    return files.length === 0 ? undefined : files.map((file) => `${toWorkspace(file)} - `);
  }
  return suite === 'commit' ? local.full.flatMap((path) => ['--skip', toWorkspace(path)]) : [];
}

/**
 * The workspace's doctests through `cargo test --doc`, which cargo-nextest can't run. A run
 * that reports no doctest but fails stands for one failing case, so a library whose doctests
 * can't build fails the tests rather than the engine.
 */
export async function cargoTests(
  ctx: Bound,
  ws: Workspace,
  local: Local,
  suite: 'commit' | 'all',
): Promise<DocRun | undefined> {
  const base = componentDir(ctx);
  const filters = doctestFilters(ws, local, suite, (path) => relativeTo(ws.root, base, path));
  if (filters === undefined) return undefined;
  const args = ['test', '--doc', '--workspace', '--all-features', '--locked', '--no-fail-fast'];
  const result = await cargo(ctx, [...args, '--', '--color', 'never', ...filters], {
    timeoutMs: HOUR,
  });
  const parsed = parseDoctests(result.stdout).map((c) => ({
    ...c,
    file: relativeTo(base, ws.root, c.file),
  }));
  const failure = tail(result, 1).slice(0, 200) || 'cargo could not build the doctests';
  const cases: Case[] =
    parsed.length === 0 && result.code !== 0
      ? [{ name: 'the doctests build', classname: 'doctests', file: 'Cargo.toml', failure }]
      : parsed;
  return { code: result.code, output: `${result.stdout}${result.stderr}`, cases, base };
}

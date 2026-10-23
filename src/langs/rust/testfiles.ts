import { posix } from 'node:path';
import { binaryId, type Package, rootDir, type Target, type Workspace } from './metadata.js';

type Binary = { readonly id: string; readonly target: Target };

/** Every test binary cargo-nextest can build, by its binary id. */
export function binaries(ws: Workspace): Binary[] {
  return ws.packages.flatMap((pkg: Package) =>
    pkg.targets.flatMap((target): Binary[] => {
      const id = binaryId(pkg, target);
      return id === undefined ? [] : [{ id, target }];
    }),
  );
}

/**
 * The file a test is written in, relative to the component: its binary's crate root, followed
 * down the module path while each module is a file of its own (`a.rs` or `a/mod.rs`).
 */
export function testFile(
  ws: Workspace,
  test: { readonly binary: string; readonly name: string },
  exists: (file: string) => boolean,
): string | undefined {
  const binary = binaries(ws).find((b) => b.id === test.binary);
  if (binary === undefined) return undefined;
  let file = binary.target.src;
  let dir = rootDir(binary.target);
  for (const module of test.name.split('::').slice(0, -1)) {
    const found = [`${module}.rs`, `${module}/mod.rs`]
      .map((name) => posix.join(dir, name))
      .find((path) => exists(path));
    if (found === undefined) break;
    file = found;
    dir = posix.join(dir, module);
  }
  return file;
}

function under(path: string, dir: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

/** The module path a file or directory under a crate root's directory stands for. */
export function modulePath(path: string, dir: string): string {
  const inside = dir === '' ? path : path.slice(dir.length + 1);
  return inside
    .replace(/\.rs$/, '')
    .replace(/(^|\/)mod$/, '')
    .split('/')
    .filter((part) => part !== '')
    .join('::');
}

/**
 * A nextest filterset for the tests written in the given files or directories (relative to the
 * component): a whole binary for its crate root or anything above it, otherwise the tests under
 * the module the file holds. Undefined when no test binary has code there.
 */
export function filterFor(ws: Workspace, paths: readonly string[]): string | undefined {
  const parts = binaries(ws).flatMap((binary) =>
    paths.flatMap((path): string[] => {
      const id = `binary_id(=${binary.id})`;
      if (under(binary.target.src, path)) return [id];
      const dir = rootDir(binary.target);
      if (!under(path, dir) || (!path.endsWith('.rs') && path.includes('.'))) return [];
      const module = modulePath(path, dir);
      return module === '' ? [id] : [`(${id} & test(/^${module}::/))`];
    }),
  );
  return parts.length === 0 ? undefined : [...new Set(parts)].join(' | ');
}

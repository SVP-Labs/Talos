import { dirname } from 'node:path';
import { z } from 'zod';
import { relativeTo } from './paths.js';
import { type Bound, cargo, failed } from './run.js';
import { EngineError } from '../../core/check.js';
import { componentDir } from '../../core/component.js';

/** One Cargo target: a library, a binary, an integration test, a bench, an example. */
export type Target = {
  readonly name: string;
  readonly kinds: readonly string[];
  /** The crate root, relative to the component's directory. */
  readonly src: string;
  readonly doctest: boolean;
};

export type Package = {
  readonly name: string;
  /** The manifest, relative to the component's directory. */
  readonly manifest: string;
  readonly targets: readonly Target[];
};

export type Workspace = {
  /** Absolute. */
  readonly root: string;
  readonly packages: readonly Package[];
};

const metadataSchema = z.object({
  workspace_root: z.string(),
  packages: z.array(
    z.object({
      name: z.string(),
      manifest_path: z.string(),
      targets: z.array(
        z.object({
          name: z.string(),
          kind: z.array(z.string()),
          src_path: z.string(),
          doctest: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

/** `cargo metadata --no-deps --format-version 1`, with paths relative to the component. */
export function parseMetadata(text: string, dir: string): Workspace {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EngineError(`cargo metadata printed no readable JSON: ${text.slice(0, 200)}`);
  }
  const parsed = metadataSchema.safeParse(json);
  if (!parsed.success) {
    throw new EngineError(`cargo metadata printed JSON of another shape: ${parsed.error.message}`);
  }
  return {
    root: parsed.data.workspace_root,
    packages: parsed.data.packages.map((pkg) => ({
      name: pkg.name,
      manifest: relativeTo(dir, dir, pkg.manifest_path),
      targets: pkg.targets.map((target) => ({
        name: target.name,
        kinds: target.kind,
        src: relativeTo(dir, dir, target.src_path),
        doctest: target.doctest ?? false,
      })),
    })),
  };
}

/** The component's workspace, read once per run. */
export async function workspace(ctx: Bound): Promise<Workspace> {
  return ctx.memo(`rust/metadata:${ctx.component.root}`, async () => {
    const args = ['metadata', '--format-version', '1', '--no-deps', '--locked'];
    const result = await cargo(ctx, args);
    if (result.code !== 0) throw failed('cargo metadata', result);
    return parseMetadata(result.stdout, componentDir(ctx));
  });
}

const LIBRARY_KINDS = new Set(['lib', 'rlib', 'dylib', 'cdylib', 'staticlib', 'proc-macro']);

export function isLibrary(target: Target): boolean {
  return target.kinds.some((kind) => LIBRARY_KINDS.has(kind));
}

/** The directory a target's modules live in: its crate root's. */
export function rootDir(target: Target): string {
  const dir = dirname(target.src);
  return dir === '.' ? '' : dir;
}

/**
 * The name cargo-nextest gives a target's test binary: the package for its library,
 * `<package>::<test>` for an integration test, `<package>::<kind>/<name>` for the rest.
 */
export function binaryId(pkg: Package, target: Target): string | undefined {
  if (isLibrary(target)) return pkg.name;
  if (target.kinds.includes('test')) return `${pkg.name}::${target.name}`;
  const kind = ['bin', 'bench', 'example'].find((k) => target.kinds.includes(k));
  return kind === undefined ? undefined : `${pkg.name}::${kind}/${target.name}`;
}

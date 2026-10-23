import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { ApplyContext } from '../../core/check.js';
import type { Place } from '../../core/component.js';

/** A `rustflags` setting in one of the repository's `.cargo/config.toml` files. */
export type Rustflags = {
  /** Repository-relative. */
  readonly file: string;
  /** `build.rustflags` or `target.<triple or cfg>.rustflags`. */
  readonly key: string;
  readonly flags: readonly string[];
};

const flagsSchema = z.union([z.array(z.string()), z.string()]);
const configSchema = z.object({
  build: z.object({ rustflags: flagsSchema.optional() }).optional(),
  target: z.record(z.string(), z.object({ rustflags: flagsSchema.optional() })).optional(),
});

function asList(flags: z.infer<typeof flagsSchema>): string[] {
  return typeof flags === 'string' ? flags.split(' ').filter((flag) => flag !== '') : flags;
}

/** The `rustflags` a config file sets, in the order cargo reads them. */
export function parseRustflags(file: string, text: string): Rustflags[] {
  let parsed: z.infer<typeof configSchema>;
  try {
    const result = configSchema.safeParse(parseToml(text));
    if (!result.success) return [];
    parsed = result.data;
  } catch {
    return [];
  }
  const found: Rustflags[] = [];
  if (parsed.build?.rustflags !== undefined) {
    found.push({ file, key: 'build.rustflags', flags: asList(parsed.build.rustflags) });
  }
  for (const [target, table] of Object.entries(parsed.target ?? {})) {
    if (table.rustflags === undefined) continue;
    found.push({ file, key: `target.${target}.rustflags`, flags: asList(table.rustflags) });
  }
  return found;
}

/**
 * The config files cargo reads for the component, from the repository's root down to the
 * component, as cargo merges them (deeper files later). Files outside the repository are the
 * machine's, not the project's.
 */
function configPaths(ctx: Pick<ApplyContext, 'facts'> & Pick<Place, 'component'>): string[] {
  const parts = ctx.component.root === '.' ? [] : ctx.component.root.split('/');
  const dirs = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  const tracked = new Set(ctx.facts.files);
  return ['', ...dirs].flatMap((dir) =>
    ['config', 'config.toml']
      .map((name) => posix.join(dir, '.cargo', name))
      .filter((path) => tracked.has(path)),
  );
}

export async function readRustflags(
  ctx: Pick<ApplyContext, 'facts'> & Pick<Place, 'component' | 'root'>,
): Promise<Rustflags[]> {
  const found: Rustflags[] = [];
  for (const path of configPaths(ctx)) {
    const text = await readFile(join(ctx.root, path), 'utf8').catch(() => '');
    found.push(...parseRustflags(path, text));
  }
  return found;
}

const LEVEL_FLAGS = /^(-A|-W|-D|-F|--(?:allow|warn|deny|forbid|force-warn|cap-lints))(=?)(.*)$/;

/** Splits flags into the ones that set lint levels and the rest. */
export function splitLintFlags(flags: readonly string[]): {
  readonly lint: string[];
  readonly rest: string[];
} {
  const lint: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i] ?? '';
    const match = LEVEL_FLAGS.exec(flag);
    if (match === null) {
      rest.push(flag);
      continue;
    }
    const joined = (match[3] ?? '') !== '';
    lint.push(joined ? flag : `${flag} ${flags[i + 1] ?? ''}`.trim());
    if (!joined) i += 1;
  }
  return { lint, rest };
}

/** Whether a lint flag lowers what rustc reports: an allow, or a cap on levels. */
export function lowers(flag: string): boolean {
  return /^(-A|--allow|--cap-lints)/.test(flag);
}

/**
 * When the project's config passes lint levels to rustc, the gate replaces its flags with
 * `build.rustflags` minus those, so `--cap-lints allow` there can't silence the gate.
 * Undefined when no change is needed.
 */
export function gateRustflags(settings: readonly Rustflags[]): string | undefined {
  if (settings.every((s) => splitLintFlags(s.flags).lint.length === 0)) return undefined;
  const build = settings.filter((s) => s.key === 'build.rustflags').flatMap((s) => s.flags);
  return splitLintFlags(build).rest.join('\u001F');
}

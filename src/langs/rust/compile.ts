import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateRustflags, readRustflags } from './cargo-config.js';
import { renderClippy } from './configs.js';
import { type Diagnostic, parseDiagnostics, sentence } from './diagnostics.js';
import { gateLintArgs } from './lints.js';
import { workspace } from './metadata.js';
import { isInside, relativeTo } from './paths.js';
import { type Bound, cargo, failed, HOUR } from './run.js';
import type { Finding } from '../../core/finding.js';
import { excludeMatcher } from '../../repo/facts.js';

const CLIPPY_ARGS = [
  'clippy',
  '--workspace',
  '--all-targets',
  '--all-features',
  '--locked',
  '--keep-going',
  '--message-format=json',
];

/** Diagnostics whose site is in a tracked file; errors elsewhere keep no site, warnings go. */
export function located(
  diagnostics: readonly Diagnostic[],
  tracked: ReadonlySet<string>,
  excluded: (file: string) => boolean,
): Diagnostic[] {
  return diagnostics.flatMap((d): Diagnostic[] => {
    if (d.site === undefined || tracked.has(d.site.file)) return [d];
    if (excluded(d.site.file) || d.level === 'warning') return [];
    const { site: _site, ...rest } = d;
    return [rest];
  });
}

async function clippyEnv(ctx: Bound): Promise<Record<string, string>> {
  const conf = join(ctx.scratch, 'clippy-conf');
  await mkdir(conf, { recursive: true });
  await writeFile(join(conf, 'clippy.toml'), renderClippy(''));
  const rustflags = gateRustflags(await readRustflags(ctx));
  return {
    CLIPPY_CONF_DIR: conf,
    ...(rustflags === undefined ? {} : { CARGO_ENCODED_RUSTFLAGS: rustflags }),
  };
}

/**
 * Clippy over every target of the workspace, once per component and run, with Talos's lint
 * levels and its own clippy.toml; rust/lint, rust/types and rust/deadcode each read their part.
 * Sites are repository-relative.
 */
export async function compiled(ctx: Bound): Promise<readonly Diagnostic[]> {
  return ctx.memo(`rust/clippy:${ctx.component.root}`, async () => {
    const ws = await workspace(ctx);
    const env = await clippyEnv(ctx);
    const result = await cargo(ctx, [...CLIPPY_ARGS, '--', ...gateLintArgs()], {
      env,
      timeoutMs: HOUR,
    });
    const repo = (file: string): string => relativeTo(ctx.root, ws.root, file);
    const own = (file: string): boolean =>
      !file.startsWith('<') && isInside(repo(file)) && !repo(file).split('/').includes('target');
    const diagnostics = parseDiagnostics(result.stdout, own).map((d) =>
      d.site === undefined ? d : { ...d, site: { ...d.site, file: repo(d.site.file) } },
    );
    if (result.code !== 0 && !diagnostics.some((d) => d.level === 'error')) {
      throw failed('cargo clippy', result);
    }
    return located(diagnostics, new Set(ctx.facts.files), excludeMatcher(ctx.config.exclude));
  });
}

/** `clippy/<lint>` for Clippy's lints, `rustc/<lint or error code>` for the compiler's. */
export function ruleOf(d: Diagnostic): string {
  if (d.code?.startsWith('clippy::') === true) return `clippy/${d.code.slice('clippy::'.length)}`;
  return `rustc/${d.code ?? d.level}`;
}

function docsFor(d: Diagnostic): string | undefined {
  if (d.code === undefined) return undefined;
  if (d.code.startsWith('clippy::')) {
    return `https://rust-lang.github.io/rust-clippy/stable/index.html#${d.code.slice(8)}`;
  }
  if (/^E\d{4}$/.test(d.code)) return `https://doc.rust-lang.org/error_codes/${d.code}.html`;
  return 'https://doc.rust-lang.org/rustc/lints/listing/index.html';
}

export function toFinding(d: Diagnostic): Finding {
  const rule = ruleOf(d);
  const message = sentence(d.message);
  const docs = docsFor(d);
  return {
    rule,
    message,
    ...(d.site === undefined
      ? { key: `${rule} ${message}` }
      : {
          location: {
            file: d.site.file,
            line: d.site.line,
            endLine: d.site.endLine,
            column: d.site.column,
          },
        }),
    ...(docs === undefined ? {} : { docs }),
  };
}

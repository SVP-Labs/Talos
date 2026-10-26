import { rustFiles } from './paths.js';
import { generatedHeader } from '../../configs/header.js';
import type { ApplyContext } from '../../core/check.js';
import type { Generated } from '../../core/pack.js';

export const RUSTFMT_BASE = 'rustfmt.toml';
export const CLIPPY_BASE = 'clippy.toml';

/**
 * Clippy's thresholds where Clippy has one. Nesting isn't among them: Clippy counts the blocks of
 * `impl` and `mod` too, so the pack measures nesting itself (rust/lint's `talos/max-depth`).
 */
export const CLIPPY_SETTINGS: Readonly<Record<string, number | boolean>> = {
  'cognitive-complexity-threshold': 15,
  'too-many-arguments-threshold': 4,
  'too-many-lines-threshold': 60,
  'allow-unwrap-in-tests': false,
  'allow-expect-in-tests': false,
  'avoid-breaking-exported-api': false,
};

/** rustfmt as it comes, written out so the gate can pass the file instead of trusting the tree. */
export const RUSTFMT_SETTINGS: Readonly<Record<string, number | string>> = {
  max_width: 100,
};

function lines(settings: Readonly<Record<string, number | string | boolean>>): string[] {
  return Object.entries(settings).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
}

export function renderRustfmt(version: string): string {
  return [
    generatedHeader('#', version).trimEnd(),
    "# rustfmt's defaults: Rust is formatted the way rustfmt formats it out of the box.",
    ...lines(RUSTFMT_SETTINGS),
    '',
  ].join('\n');
}

export function renderClippy(version: string): string {
  return [
    generatedHeader('#', version).trimEnd(),
    '# Lint levels are in the workspace Cargo.toml and on the gate command line.',
    ...lines(CLIPPY_SETTINGS),
    '',
  ].join('\n');
}

const hasRust = (ctx: ApplyContext): boolean => rustFiles(ctx).length > 0;

/**
 * Neither rustfmt nor Clippy can extend another file or be extended, so both bases are whole:
 * the gate passes its own rendering (`--config-path`, `CLIPPY_CONF_DIR`) and ignores the tree's
 * copies. A project tightens Clippy through lint levels in its Cargo.toml instead.
 */
export const rustfmtBase: Generated = {
  path: RUSTFMT_BASE,
  scope: 'component',
  langs: ['rust'],
  applies: hasRust,
  render: (ctx) => renderRustfmt(ctx.version),
};

export const clippyBase: Generated = {
  path: CLIPPY_BASE,
  scope: 'component',
  langs: ['rust'],
  applies: hasRust,
  render: (ctx) => renderClippy(ctx.version),
};

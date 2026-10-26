/**
 * The lint levels Talos holds Rust to. The gate passes them to Clippy on the command line, after
 * anything the project's `Cargo.toml` or `.cargo/config.toml` sets, so the project can't lower
 * them there; `talos adopt` writes the same levels into the manifest's lint table so the editor
 * shows what the gate reports.
 */

export type Level = 'allow' | 'warn' | 'deny' | 'forbid';

export type BaseLint = {
  readonly tool: 'rust' | 'clippy';
  readonly name: string;
  readonly level: Level;
  /** Groups go first, so the single lints after them win. */
  readonly priority?: number;
};

export const BASE_LINTS: readonly BaseLint[] = [
  { tool: 'rust', name: 'unsafe_code', level: 'deny' },
  { tool: 'clippy', name: 'all', level: 'warn', priority: -1 },
  { tool: 'clippy', name: 'pedantic', level: 'warn', priority: -1 },
  { tool: 'clippy', name: 'cognitive_complexity', level: 'warn' },
  { tool: 'clippy', name: 'unwrap_used', level: 'warn' },
  { tool: 'clippy', name: 'expect_used', level: 'warn' },
  { tool: 'clippy', name: 'dbg_macro', level: 'warn' },
  { tool: 'clippy', name: 'todo', level: 'warn' },
  { tool: 'clippy', name: 'unimplemented', level: 'warn' },
];

/** rustc's groups that warn by default, asserted again in case the project lowered them. */
const RUSTC_GROUPS = ['warnings', 'unused', 'nonstandard_style', 'future_incompatible'];

function qualified(lint: BaseLint): string {
  return lint.tool === 'clippy' ? `clippy::${lint.name}` : lint.name;
}

/**
 * Clippy's arguments for the gate. Every level is `warn` and `--cap-lints warn` keeps any
 * attribute from making a lint an error, so one crate's findings never stop the crates that
 * depend on it from being checked; every warning is a finding, which is what `-D warnings`
 * means here. `unsafe_code` is forced: no attribute silences it.
 */
export function gateLintArgs(): string[] {
  const groups = RUSTC_GROUPS.flatMap((group) => ['-W', group]);
  const lints = BASE_LINTS.filter((lint) => lint.name !== 'unsafe_code').flatMap((lint) => [
    '-W',
    qualified(lint),
  ]);
  return ['--cap-lints', 'warn', ...groups, ...lints, '--force-warn', 'unsafe_code'];
}

function entry(lint: BaseLint): string {
  const value =
    lint.priority === undefined
      ? JSON.stringify(lint.level)
      : `{ level = ${JSON.stringify(lint.level)}, priority = ${String(lint.priority)} }`;
  return `${lint.name} = ${value}`;
}

/**
 * The lint tables `talos adopt` writes at the levels above: `[workspace.lints]` in a workspace's
 * root manifest (each member then sets `[lints] workspace = true`), `[lints]` in a lone package's.
 */
export function lintsBlock(table: 'lints' | 'workspace.lints'): string {
  const section = (tool: BaseLint['tool']): string[] => [
    `[${table}.${tool}]`,
    ...BASE_LINTS.filter((lint) => lint.tool === tool).map(entry),
  ];
  return [...section('rust'), '', ...section('clippy'), ''].join('\n');
}

const ORDER: Readonly<Record<Level, number>> = { allow: 0, warn: 1, deny: 2, forbid: 3 };

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && value in ORDER;
}

export function weakerThan(level: Level, base: Level): boolean {
  return ORDER[level] < ORDER[base];
}

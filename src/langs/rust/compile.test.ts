import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compiled } from './compile.js';
import { deadCode } from './deadcode.js';
import { lint } from './lint.js';
import type { Bound } from './run.js';
import { types } from './types.js';
import { parseConfig } from '../../config/load.js';
import type { Memo } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { ExecOptions, ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

const FILES = {
  'Cargo.toml': '[workspace]\nmembers = ["core", "app"]\n',
  'core/Cargo.toml': '[package]\nname = "demo-core"\n\n[dependencies]\nserde = "1"\nitoa = "1"\n',
  'core/src/lib.rs': 'pub fn f() {}\n',
  'app/Cargo.toml': '[package]\nname = "demo-app"\n',
  'app/src/main.rs': 'fn main() {}\n',
  '.cargo/config.toml': '[build]\nrustflags = ["-A", "warnings", "-C", "opt-level=1"]\n',
};

type Site = { readonly file: string; readonly line: number };

/** A `cargo clippy --message-format=json` message (Rust 1.97), rendered text left out. */
function message(code: string | null, level: string, text: string, site?: Site): string {
  const spans =
    site === undefined
      ? []
      : [
          {
            file_name: site.file,
            line_start: site.line,
            line_end: site.line,
            column_start: 5,
            column_end: 9,
            is_primary: true,
            expansion: null,
          },
        ];
  return JSON.stringify({
    reason: 'compiler-message',
    message: {
      $message_type: 'diagnostic',
      children: [],
      code: code === null ? null : { code, explanation: null },
      level,
      message: text,
      rendered: null,
      spans,
    },
  });
}

const LIB = { file: 'core/src/lib.rs', line: 1 };
const MAIN = { file: 'app/src/main.rs', line: 1 };

const STREAM = [
  message('clippy::unwrap_used', 'warning', 'used `unwrap()` on a `Result` value', LIB),
  message('dead_code', 'warning', 'function `helper` is never used', LIB),
  message('E0308', 'error', 'mismatched types', MAIN),
  message('E0425', 'error', 'cannot find value `x` in this scope', {
    file: 'generated/out.rs',
    line: 4,
  }),
  message('unused_imports', 'warning', 'unused import: `std::fmt`', {
    file: 'generated/out.rs',
    line: 2,
  }),
  '{"reason":"build-finished","success":false}',
].join('\n');

const MACHETE = [
  'Analyzing dependencies of crates in this directory...',
  'cargo-machete found the following unused dependencies in this directory:',
  'demo-core -- ./core/Cargo.toml:',
  '\titoa',
  'demo-vendored -- ./vendor/Cargo.toml:',
  '\tlog',
  '',
  'Done!',
  '',
].join('\n');

type Call = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
};

type Answers = { readonly clippy?: ExecResult; readonly machete?: ExecResult };

function isPromise<T>(value: unknown): value is Promise<T> {
  return value instanceof Promise;
}

/** A run's memo: each key computed once. */
function memo(): Memo {
  const cache = new Map<string, unknown>();
  return async <T>(key: string, compute: () => Promise<T>): Promise<T> => {
    const known = cache.get(key);
    if (isPromise<T>(known)) return known;
    const started = compute();
    cache.set(key, started);
    return started;
  };
}

async function context(
  answers: Answers = {},
  files: Readonly<Record<string, string>> = FILES,
): Promise<{ ctx: Bound; calls: Call[] }> {
  const root = await tempRepo(files);
  const calls: Call[] = [];
  const config = parseConfig(MINIMAL_CONFIG);
  const ctx: Bound = {
    root,
    sha: '0'.repeat(40),
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === '/tools/cargo-machete') {
        return Promise.resolve(answers.machete ?? { code: 1, stdout: MACHETE, stderr: '' });
      }
      if (args[0] === 'metadata') {
        const metadata = { workspace_root: root, packages: [] };
        return Promise.resolve({ code: 0, stdout: JSON.stringify(metadata), stderr: '' });
      }
      return Promise.resolve(answers.clippy ?? { code: 101, stdout: STREAM, stderr: '' });
    },
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch: await mkdtemp(join(tmpdir(), 'talos-rust-compile-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(files), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: memo(),
    component: { lang: 'rust', root: '.', os: ['linux'] },
  };
  return { ctx, calls };
}

describe('the Clippy run rust/lint, rust/types and rust/deadcode share', () => {
  it('runs Clippy once with the gate’s config and rustflags, and gives each check its part', async () => {
    const { ctx, calls } = await context();
    expect((await lint(ctx)).map((f) => [f.rule, f.location?.file])).toEqual([
      ['clippy/unwrap_used', 'core/src/lib.rs'],
    ]);
    expect((await types(ctx)).map((f) => [f.rule, f.location?.file, f.key])).toEqual([
      ['rustc/E0308', 'app/src/main.rs', undefined],
      ['rustc/E0425', undefined, 'rustc/E0425 Cannot find value `x` in this scope.'],
    ]);
    const dead = await deadCode(ctx);
    expect(dead).toEqual([
      {
        rule: 'rustc/dead_code',
        message: 'Function `helper` is never used.',
        location: { file: 'core/src/lib.rs', line: 1, endLine: 1, column: 5 },
        docs: 'https://doc.rust-lang.org/rustc/lints/listing/index.html',
      },
      {
        rule: 'cargo-machete/unused-dependency',
        message: 'demo-core depends on itoa, which its code never uses.',
        location: { file: 'core/Cargo.toml', line: 6 },
        docs: 'https://github.com/bnjbvr/cargo-machete',
      },
    ]);
    const clippy = calls.filter((c) => c.args[0] === 'clippy');
    expect(clippy).toHaveLength(1);
    const env = clippy[0]?.options.env ?? {};
    expect(env.CARGO_ENCODED_RUSTFLAGS).toBe('-C\u001Fopt-level=1');
    expect(await readFile(join(env.CLIPPY_CONF_DIR ?? '', 'clippy.toml'), 'utf8')).toContain(
      'too-many-arguments-threshold = 4',
    );
    expect(calls.find((c) => c.command === '/tools/cargo-machete')?.args).toEqual([
      '--with-metadata',
      '--skip-target-dir',
      '.',
    ]);
  });

  it('is an engine error when Clippy fails without a compiler error to show for it', async () => {
    const warningsOnly = message('dead_code', 'warning', 'unused', LIB);
    const { ctx } = await context({
      clippy: { code: 101, stdout: warningsOnly, stderr: 'killed' },
    });
    await expect(compiled(ctx)).rejects.toThrow('cargo clippy exited 101');
  });

  it('is an engine error when cargo-machete crashes or fails without naming a dependency', async () => {
    const crashed = await context({
      clippy: { code: 0, stdout: '', stderr: '' },
      machete: { code: 2, stdout: '', stderr: 'boom' },
    });
    await expect(deadCode(crashed.ctx)).rejects.toThrow('cargo-machete exited 2');
    const silent = await context({
      clippy: { code: 0, stdout: '', stderr: '' },
      machete: { code: 1, stdout: 'Done!\n', stderr: '' },
    });
    await expect(deadCode(silent.ctx)).rejects.toThrow('cargo-machete exited 1');
  });

  it('finds nothing in a clean workspace, and leaves rustflags alone that lower nothing', async () => {
    const { '.cargo/config.toml': _flags, ...files } = FILES;
    const answers = {
      clippy: { code: 0, stdout: '', stderr: '' },
      machete: { code: 0, stdout: 'Done!\n', stderr: '' },
    };
    const clean = await context(answers, files);
    expect(await deadCode(clean.ctx)).toEqual([]);
    expect(await types(clean.ctx)).toEqual([]);
    expect(clean.calls.find((c) => c.args[0] === 'clippy')?.options.env).not.toHaveProperty(
      'CARGO_ENCODED_RUSTFLAGS',
    );
  });
});

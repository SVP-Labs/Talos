import { mkdtemp, readFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { format, parseRustfmtCheck, unformattedMessage, unparsable } from './format.js';
import type { Bound } from './run.js';
import { parseConfig } from '../../config/load.js';
import { silentLogger } from '../../core/log.js';
import type { ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

/** Recorded from `cargo fmt --all --check -- --color never` (rustfmt 1.9.0, Rust 1.97). */
const CHECK = `Diff in /ws/app/src/main.rs:1:
 fn main() {
-\tlet x: i32 = 1;
-\tprintln!("{}", demo_core::add(1, x));
+    let x: i32 = 1;
+    println!("{}", demo_core::add(1, x));
 }

 fn other() {
Diff in /ws/app/src/main.rs:7:
-\tlet a = 1;
-\tif a == 1 {
+    let a = 1;
+    if a == 1 {
 }
Diff in C:\\ws\\core\\src\\lib.rs:4:
 fn f() {}
+
 fn g() {}
`;

const STDERR = `error: this file contains an unclosed delimiter
 --> /ws/core/src/broken.rs:1:14
  |
1 | fn broken( {
  |          - -^

Error writing files: failed to resolve mod \`broken\`: cannot parse /ws/core/src/broken.rs
`;

describe('parseRustfmtCheck', () => {
  it('spans each file from its first to its last line rustfmt would change', () => {
    expect(parseRustfmtCheck(CHECK)).toEqual([
      { file: '/ws/app/src/main.rs', line: 2, endLine: 8 },
      { file: String.raw`C:\ws\core\src\lib.rs`, line: 4, endLine: 4 },
    ]);
  });

  it('reads nothing from a clean run', () => {
    expect(parseRustfmtCheck('')).toEqual([]);
  });
});

describe('unformattedMessage', () => {
  it('names one line or a range', () => {
    expect(unformattedMessage({ file: 'a.rs', line: 3, endLine: 3 })).toBe(
      "Line 3 isn't formatted the way rustfmt writes it.",
    );
    expect(unformattedMessage({ file: 'a.rs', line: 3, endLine: 9 })).toBe(
      "Lines 3 to 9 aren't formatted the way rustfmt writes them.",
    );
  });
});

describe('unparsable', () => {
  it('names the files rustfmt could not parse', () => {
    expect(unparsable(STDERR)).toEqual(['/ws/core/src/broken.rs']);
  });
});

describe('format', () => {
  const files = {
    'rs/Cargo.toml': '[package]\nname = "app"\n',
    'rs/src/main.rs': 'fn main() {}\n',
  };

  /**
   * A checkout reached through a link, which cargo fmt prints canonical: resolved, and on
   * Windows with the `\\?\` prefix, as a runner's short-named temp directory is printed.
   */
  async function linked(): Promise<{ root: string; printed: string }> {
    const real = await tempRepo(files);
    const root = join(await mkdtemp(join(tmpdir(), 'talos-link-')), 'checkout');
    await symlink(real, root, 'junction');
    const canonical = await realpath(real);
    return { root, printed: process.platform === 'win32' ? `\\\\?\\${canonical}` : canonical };
  }

  async function run(
    answer: ExecResult,
    at?: { root: string; printed: string },
  ): Promise<{ found: Awaited<ReturnType<typeof format>>; args: string[] }> {
    const root = at?.root ?? (await tempRepo(files));
    const printed = at?.printed ?? root;
    const config = parseConfig(MINIMAL_CONFIG);
    const args: string[] = [];
    const ctx: Bound = {
      root,
      sha: '0'.repeat(40),
      exec: (_command, given) => {
        args.push(...given);
        return Promise.resolve({ ...answer, stdout: answer.stdout.replaceAll('{root}', printed) });
      },
      tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
      scratch: await mkdtemp(join(tmpdir(), 'talos-rustfmt-')),
      log: silentLogger,
      os: 'linux',
      facts: repoFacts(Object.keys(files), config.exclude),
      config,
      side: 'alone',
      tiers: ['commit', 'head'],
      memo: (_key, compute) => compute(),
      component: { lang: 'rust', root: 'rs', os: ['linux'] },
    };
    return { found: await format(ctx), args };
  }

  it("reports the component's own files rustfmt would change, under Talos's settings", async () => {
    const stdout = [
      'Diff in {root}/rs/src/main.rs:1:',
      '-fn main() {}',
      '+fn main() {',
      '+}',
      'Diff in {root}/vendor/dep.rs:3:',
      '-x',
      '+y',
      'Diff in {root}/rs/target/gen.rs:1:',
      '-x',
      '',
    ].join('\n');
    const { found, args } = await run({ code: 1, stdout, stderr: '' });
    expect(found).toEqual([
      {
        rule: 'rustfmt/format',
        message: "Line 1 isn't formatted the way rustfmt writes it.",
        location: { file: 'rs/src/main.rs', line: 1, endLine: 1 },
      },
    ]);
    const config = args[args.indexOf('--config-path') + 1] ?? '';
    expect(await readFile(config, 'utf8')).toContain('max_width = 100');
  });

  it('places files cargo fmt prints by their canonical path', async () => {
    const stdout = `Diff in {root}${sep}rs${sep}src${sep}main.rs:1:\n-fn main() {}\n+fn main() {\n`;
    const { found } = await run({ code: 1, stdout, stderr: '' }, await linked());
    expect(found.map((f) => f.location)).toEqual([{ file: 'rs/src/main.rs', line: 1, endLine: 1 }]);
  });

  it("leaves files it couldn't parse to rust/types", async () => {
    const stderr = 'error: expected item\n --> rs/src/main.rs:1:1\n';
    expect((await run({ code: 1, stdout: '', stderr })).found).toEqual([]);
  });

  it('is an engine error when cargo fmt fails for another reason', async () => {
    await expect(
      run({ code: 1, stdout: '', stderr: 'error: no such command: `fmt`' }),
    ).rejects.toThrow('cargo fmt exited 1');
  });
});

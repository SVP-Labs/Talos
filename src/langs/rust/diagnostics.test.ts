import { describe, expect, it } from 'vitest';
import { located, ruleOf, toFinding } from './compile.js';
import { parseDiagnostics, sentence } from './diagnostics.js';

/** Recorded from `cargo clippy --message-format=json` on Rust 1.97 (rendered text left out). */
const span = (file: string, line: number, expansion: unknown = null): unknown => ({
  file_name: file,
  line_start: line,
  line_end: line,
  column_start: 5,
  column_end: 33,
  is_primary: true,
  expansion,
});

const message = (code: string | null, level: string, text: string, spans: unknown[]): string =>
  JSON.stringify({
    reason: 'compiler-message',
    package_id: 'path+file:///ws/core#demo-core@0.1.0',
    target: { kind: ['lib'], name: 'demo_core' },
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

const unwrap = message('clippy::unwrap_used', 'warning', 'used `unwrap()` on a `Result` value', [
  span('core/src/lib.rs', 17),
]);

const STREAM = [
  '{"reason":"compiler-artifact","package_id":"registry+https://github.com/rust-lang/crates.io-index#itoa@1.0.18","target":{"kind":["lib"]}}',
  unwrap,
  unwrap,
  message('dead_code', 'warning', 'function `unused_helper` is never used', [
    span('core/src/lib.rs', 11),
  ]),
  message('E0308', 'error', 'mismatched types', [span('app/src/main.rs', 2)]),
  message(null, 'error', 'aborting due to 1 previous error', []),
  message(
    null,
    'failure-note',
    'For more information about this error, try `rustc --explain E0308`.',
    [],
  ),
  message(
    'clippy::uninlined_format_args',
    'warning',
    'variables can be used directly in the `format!` string',
    [span('/rustc/2d8144b/library/std/src/macros.rs', 143, { span: span('app/src/main.rs', 3) })],
  ),
  '{"reason":"build-finished","success":false}',
].join('\n');

const own = (file: string): boolean => !file.startsWith('/');

describe('parseDiagnostics', () => {
  it('reads each diagnostic once, without summaries or other messages', () => {
    const found = parseDiagnostics(STREAM, own);
    expect(found.map((d) => [d.level, d.code])).toEqual([
      ['warning', 'clippy::unwrap_used'],
      ['warning', 'dead_code'],
      ['error', 'E0308'],
      ['warning', 'clippy::uninlined_format_args'],
    ]);
  });

  it('follows macro expansions out to the project’s own file', () => {
    const found = parseDiagnostics(STREAM, own).at(-1);
    expect(found?.site).toEqual({ file: 'app/src/main.rs', line: 3, endLine: 3, column: 5 });
  });

  it('refuses a stream that isn’t JSON and a compiler crash', () => {
    expect(() => parseDiagnostics('{not json', own)).toThrow(/isn't JSON/);
    const ice = message(null, 'error: internal compiler error', 'unexpected panic', []);
    expect(() => parseDiagnostics(ice, own)).toThrow(/internal compiler error/);
  });
});

describe('findings from diagnostics', () => {
  const [lint, dead, error] = parseDiagnostics(STREAM, own);

  it('names rules after the tool and lint or error code', () => {
    expect([lint, dead, error].map((d) => (d === undefined ? '' : ruleOf(d)))).toEqual([
      'clippy/unwrap_used',
      'rustc/dead_code',
      'rustc/E0308',
    ]);
  });

  it('writes one sentence with the location and documentation', () => {
    expect(lint === undefined ? undefined : toFinding(lint)).toEqual({
      rule: 'clippy/unwrap_used',
      message: 'Used `unwrap()` on a `Result` value.',
      location: { file: 'core/src/lib.rs', line: 17, endLine: 17, column: 5 },
      docs: 'https://rust-lang.github.io/rust-clippy/stable/index.html#unwrap_used',
    });
  });

  it('keeps diagnostics in tracked files, drops warnings elsewhere and unlocates errors', () => {
    const tracked = new Set(['core/src/lib.rs']);
    const kept = located(parseDiagnostics(STREAM, own), tracked, (f) => f.startsWith('vendor/'));
    expect(kept.map((d) => [d.code, d.site?.file])).toEqual([
      ['clippy::unwrap_used', 'core/src/lib.rs'],
      ['dead_code', 'core/src/lib.rs'],
      ['E0308', undefined],
    ]);
    const unlocated = kept[2];
    expect(unlocated === undefined ? undefined : toFinding(unlocated).key).toBe(
      'rustc/E0308 Mismatched types.',
    );
  });

  it('clips and punctuates messages', () => {
    expect(sentence('this function has too many lines (61/60)')).toBe(
      'This function has too many lines (61/60).',
    );
    expect(sentence('x'.repeat(400))).toHaveLength(300);
  });
});

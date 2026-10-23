import { describe, expect, it } from 'vitest';
import { clippyBase, renderClippy, renderRustfmt, rustfmtBase } from './configs.js';
import type { Diagnostic } from './diagnostics.js';
import { rustPack } from './index.js';
import { lintDiagnostics, widened } from './lint.js';
import { classify, isTestCode, shapeFindings } from './shapes.js';
import { shapeOf } from './structure.js';
import { parseConfig } from '../../config/load.js';
import { repoFacts } from '../../repo/facts.js';

const long = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `const C${String(i)}: i32 = ${String(i)};`).join('\n');

const files = new Map([
  ['src/lib.rs', shapeOf(`${long(401)}\n#[cfg(test)]\nmod helpers;\n`)],
  ['src/helpers.rs', shapeOf(long(500))],
  ['tests/big.rs', shapeOf(long(500))],
  ['src/small.rs', shapeOf(`${long(390)}\n#[cfg(test)]\nmod tests {\n${long(50)}\n}\n`)],
  ['src/deep.rs', shapeOf('fn f() {\n if a {\n if b {\n if c {\n if d {}\n }\n }\n }\n}\n')],
]);
const all = classify(files);

describe('classify', () => {
  it('knows test files by directory and by test module declaration', () => {
    expect([...all.testFiles].sort((a, b) => a.localeCompare(b))).toEqual([
      'src/helpers.rs',
      'tests/big.rs',
    ]);
    expect(isTestCode(all, 'src/small.rs', 393)).toBe(true);
    expect(isTestCode(all, 'src/small.rs', 1)).toBe(false);
  });
});

describe('shapeFindings', () => {
  it('limits lines of code per file outside tests, and nesting everywhere', () => {
    const findings = shapeFindings(all, 'desktop');
    expect(
      findings.map((f) => [f.rule, f.location?.file, f.location?.line, f.location?.endLine]),
    ).toEqual([
      ['talos/max-lines', 'desktop/src/lib.rs', 401, 401],
      ['talos/max-depth', 'desktop/src/deep.rs', 5, 5],
    ]);
    expect(findings[0]?.message).toBe(
      'This file has 401 lines of code outside its tests; the most allowed is 400.',
    );
  });
});

describe('lintDiagnostics', () => {
  const at = (code: string, file: string, line: number): Diagnostic => ({
    code,
    level: 'warning',
    message: code,
    site: { file, line, endLine: line, column: 1 },
  });

  it('leaves dead code to rust/deadcode and size limits out of tests', () => {
    const kept = lintDiagnostics(
      [
        at('dead_code', 'desktop/src/lib.rs', 1),
        at('clippy::too_many_lines', 'desktop/tests/big.rs', 1),
        at('clippy::too_many_lines', 'desktop/src/small.rs', 393),
        at('clippy::too_many_lines', 'desktop/src/small.rs', 2),
        at('clippy::cognitive_complexity', 'desktop/src/small.rs', 393),
        { level: 'error', message: 'mismatched types', code: 'E0308' },
      ],
      all,
      'desktop',
    );
    expect(kept.map((d) => [d.code, d.site?.line])).toEqual([
      ['clippy::too_many_lines', 2],
      ['clippy::cognitive_complexity', 393],
    ]);
  });
});

describe('widened', () => {
  const source = [
    '/// Long.',
    'pub fn long(',
    '    a: u32,',
    ') -> u32 {',
    '    a + 1',
    '}',
    '',
    'pub fn other() {}',
  ].join('\n');
  const one = classify(new Map([['src/lib.rs', shapeOf(source)]]));
  const at = (code: string, line: number): Diagnostic => ({
    code,
    level: 'warning',
    message: code,
    site: { file: 'app/src/lib.rs', line, endLine: line, column: 8 },
  });

  it('spans a function-level lint over the whole function', () => {
    expect(widened(at('clippy::cognitive_complexity', 2), one, 'app').site).toMatchObject({
      line: 2,
      endLine: 6,
    });
    expect(widened(at('clippy::too_many_arguments', 4), one, 'app').site?.endLine).toBe(6);
  });

  it('leaves other lints, and sites outside a signature, as they are', () => {
    expect(widened(at('clippy::unwrap_used', 2), one, 'app').site?.endLine).toBe(2);
    expect(widened(at('clippy::too_many_lines', 5), one, 'app').site?.endLine).toBe(5);
    expect(widened(at('clippy::too_many_lines', 2), one, 'elsewhere').site?.endLine).toBe(2);
  });
});

describe('the pack', () => {
  it('puts format, lint, types and dead code in the commit tier', () => {
    const tiers = Object.fromEntries(rustPack.checks.map((c) => [c.id, c.tier]));
    expect(tiers).toMatchObject({
      'rust/format': 'commit',
      'rust/lint': 'commit',
      'rust/types': 'commit',
      'rust/deadcode': 'commit',
      'rust/config-strength': 'head',
      'rust/toolchain': 'head',
    });
  });

  it('applies to a component with Rust files only', () => {
    const config = parseConfig('name: T\nprefix: T\ncomponents:\n  - { lang: rust, root: app }\n');
    const component = config.components[0];
    const facts = repoFacts(['app/src/main.rs', 'app/target/debug/build/x/out.rs'], []);
    const lint = rustPack.checks.find((c) => c.id === 'rust/lint');
    const ctx = { facts, config, side: 'alone', tiers: ['commit'] } as const;
    expect(lint?.applies({ ...ctx, ...(component ? { component } : {}) })).toEqual({
      applies: true,
    });
    const empty = { ...ctx, facts: repoFacts(['app/README.md'], []) };
    expect(lint?.applies({ ...empty, ...(component ? { component } : {}) }).applies).toBe(false);
  });

  it('renders whole bases with Talos’s header and settings', () => {
    expect(renderClippy('1.2.3')).toBe(
      [
        '# Generated by Talos 1.2.3. Do not edit.',
        '# Lint levels are in the workspace Cargo.toml and on the gate command line.',
        'cognitive-complexity-threshold = 15',
        'too-many-arguments-threshold = 4',
        'too-many-lines-threshold = 60',
        'allow-unwrap-in-tests = false',
        'allow-expect-in-tests = false',
        'avoid-breaking-exported-api = false',
        '',
      ].join('\n'),
    );
    expect(renderRustfmt('1.2.3')).toContain('max_width = 100');
    expect([rustfmtBase.path, clippyBase.path]).toEqual(['rustfmt.toml', 'clippy.toml']);
    expect(rustfmtBase.extension).toBeUndefined();
  });
});

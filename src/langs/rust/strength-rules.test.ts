import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parseRustflags } from './cargo-config.js';
import { lintsBlock } from './lints.js';
import {
  lineOf,
  lintTableFindings,
  macheteFindings,
  rustflagFindings,
  shadowingFindings,
  tableAt,
} from './strength-rules.js';

const rules = (findings: readonly { key?: string }[]): (string | undefined)[] =>
  findings.map((f) => f.key);

describe('lintTableFindings', () => {
  it('accepts Talos’s block and anything stricter', () => {
    const text = `[workspace]\nmembers = []\n\n${lintsBlock('workspace.lints')}\nmissing_docs = "deny"\n`;
    const table = tableAt(parseToml(text), ['workspace', 'lints']);
    expect(lintTableFindings({ file: 'Cargo.toml', text }, 'workspace.lints', table)).toEqual([]);
  });

  it('reports a level left out or lowered, and every allow', () => {
    const text = [
      '[lints.rust]',
      'unsafe_code = "warn"',
      '',
      '[lints.clippy]',
      'pedantic = { level = "warn", priority = -1 }',
      'all = { level = "warn", priority = -1 }',
      'cognitive-complexity = "warn"',
      'unwrap_used = "allow"',
      'expect_used = "deny"',
      'dbg_macro = "warn"',
      'todo = "warn"',
      'unimplemented = "warn"',
      'module_name_repetitions = "allow"',
      '',
    ].join('\n');
    const findings = lintTableFindings(
      { file: 'core/Cargo.toml', text },
      'lints',
      tableAt(parseToml(text), ['lints']),
    );
    expect(rules(findings)).toEqual([
      'core/Cargo.toml lints.rust.unsafe_code',
      'core/Cargo.toml lints.clippy.unwrap_used',
      'core/Cargo.toml lints.clippy.module_name_repetitions',
    ]);
    expect(findings[0]).toMatchObject({
      rule: 'config/weaker',
      message: 'core/Cargo.toml sets unsafe_code to warn; Talos holds it at deny.',
      location: { file: 'core/Cargo.toml', line: 2 },
    });
    expect(findings[1]?.message).toBe(
      'core/Cargo.toml sets clippy::unwrap_used to allow; Talos holds it at warn.',
    );
    expect(findings[2]?.message).toBe(
      'core/Cargo.toml allows clippy::module_name_repetitions, which the gate reports.',
    );
  });

  it('reports a crate with no lint table at all once', () => {
    expect(rules(lintTableFindings({ file: 'Cargo.toml', text: '' }, 'lints', undefined))).toEqual([
      'Cargo.toml lints',
    ]);
  });
});

describe('shadowingFindings', () => {
  it('reports each setting that differs from the base', () => {
    const text =
      'too-many-lines-threshold = 100\ncognitive-complexity-threshold = 15\ndoc-valid-idents = ["GitHub"]\n';
    const findings = shadowingFindings(
      { file: 'core/clippy.toml', text },
      parseToml(text),
      { 'too-many-lines-threshold': 60, 'cognitive-complexity-threshold': 15 },
      'clippy',
    );
    expect(findings.map((f) => [f.key, f.location?.line])).toEqual([
      ['core/clippy.toml clippy too-many-lines-threshold', 1],
      ['core/clippy.toml clippy doc-valid-idents', 3],
    ]);
  });
});

describe('rustflagFindings and macheteFindings', () => {
  it('reports flags that lower lint levels', () => {
    const text = ['[build]', 'rustflags = ["-A", "dead_code", "-D", "warnings"]', ''].join('\n');
    const findings = rustflagFindings(
      parseRustflags('.cargo/config.toml', text),
      new Map([['.cargo/config.toml', text]]),
    );
    expect(findings.map((f) => [f.message, f.location?.line])).toEqual([
      [
        '.cargo/config.toml passes -A dead_code to rustc in build.rustflags, which lowers lint levels.',
        2,
      ],
    ]);
  });

  it('reports cargo-machete’s ignore lists', () => {
    const text = '[package]\nname = "a"\n\n[package.metadata.cargo-machete]\nignored = ["prost"]\n';
    expect(rules(macheteFindings({ file: 'Cargo.toml', text }, parseToml(text)))).toEqual([
      'Cargo.toml cargo-machete ignored prost',
    ]);
  });
});

describe('lineOf', () => {
  it('looks for a key after its table header', () => {
    const text = '[a]\nx = 1\n[b]\nx = 2\n';
    expect(lineOf(text, 'x', '[b]')).toBe(4);
    expect(lineOf(text, 'y', '[b]')).toBe(3);
    expect(lineOf(text, 'y')).toBe(1);
  });

  it('reads a quoted key as written, and no longer key that starts with it', () => {
    const text = '[lints]\nmax_width_x = 1\n"max.width" = 2\n';
    expect(lineOf(text, 'max.width', '[lints]')).toBe(3);
    expect(lineOf(text, 'max_width', '[lints]')).toBe(1);
  });
});

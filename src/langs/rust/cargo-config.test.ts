import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { gateRustflags, lowers, parseRustflags, splitLintFlags } from './cargo-config.js';
import { BASE_LINTS, gateLintArgs, isLevel, lintsBlock, weakerThan } from './lints.js';

const CONFIG = `
[build]
rustflags = ["--cfg", "tokio_unstable", "--cap-lints", "allow"]

[target.x86_64-pc-windows-msvc]
rustflags = "-C target-feature=+crt-static --allow=clippy::pedantic"
`;

describe('parseRustflags', () => {
  it('reads build and target flags, as arrays or strings', () => {
    expect(parseRustflags('.cargo/config.toml', CONFIG)).toEqual([
      {
        file: '.cargo/config.toml',
        key: 'build.rustflags',
        flags: ['--cfg', 'tokio_unstable', '--cap-lints', 'allow'],
      },
      {
        file: '.cargo/config.toml',
        key: 'target.x86_64-pc-windows-msvc.rustflags',
        flags: ['-C', 'target-feature=+crt-static', '--allow=clippy::pedantic'],
      },
    ]);
    expect(parseRustflags('x', 'not = [toml')).toEqual([]);
  });
});

describe('lint flags', () => {
  it('splits lint levels from the other flags, in both spellings', () => {
    const warnAll = ['-W', 'clippy::all'].join('');
    expect(splitLintFlags(['-A', 'dead_code', warnAll, '--cfg', 'x', '--cap-lints=warn'])).toEqual({
      lint: ['-A dead_code', warnAll, '--cap-lints=warn'],
      rest: ['--cfg', 'x'],
    });
    expect(['-A dead_code', '--allow x', '--cap-lints allow', '-D warnings'].map(lowers)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('drops the project’s lint flags for the gate only when there are some', () => {
    const settings = parseRustflags('.cargo/config.toml', CONFIG);
    expect(gateRustflags(settings)).toBe('--cfg\u001Ftokio_unstable');
    expect(
      gateRustflags(parseRustflags('c', ['[build]', 'rustflags = ["--cfg", "x"]'].join('\n'))),
    ).toBeUndefined();
  });
});

describe('lint levels', () => {
  it('passes every level as a warning, capped, with unsafe code forced', () => {
    const args = gateLintArgs();
    expect(args.slice(0, 2)).toEqual(['--cap-lints', 'warn']);
    expect(args).toContain('clippy::pedantic');
    expect(args).toContain('clippy::unwrap_used');
    expect(args.slice(-2)).toEqual(['--force-warn', 'unsafe_code']);
    expect(args.filter((arg) => arg.startsWith('-')).every((arg) => /^(-W|--)/.test(arg))).toBe(
      true,
    );
  });

  it('writes lint tables Cargo can read, for a workspace or a lone package', () => {
    expect(parseToml(lintsBlock('workspace.lints'))).toMatchObject({
      workspace: {
        lints: {
          rust: { unsafe_code: 'deny' },
          clippy: { pedantic: { level: 'warn', priority: -1 }, unwrap_used: 'warn' },
        },
      },
    });
    expect(parseToml(lintsBlock('lints'))).toMatchObject({
      lints: { rust: { unsafe_code: 'deny' }, clippy: { expect_used: 'warn' } },
    });
    expect(BASE_LINTS.every((lint) => isLevel(lint.level))).toBe(true);
  });

  it('orders levels', () => {
    expect(weakerThan('allow', 'warn')).toBe(true);
    expect(weakerThan('forbid', 'deny')).toBe(false);
    expect(isLevel('expect')).toBe(false);
  });
});

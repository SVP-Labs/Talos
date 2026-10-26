import { describe, expect, it } from 'vitest';
import { parseToolchain, toolchainFile, toolchainFindings } from './toolchain.js';

const PINNED = '[toolchain]\nchannel = "1.97.0"\ncomponents = ["clippy", "rustfmt"]\n';

describe('parseToolchain', () => {
  it('reads the TOML form and the legacy one-line form', () => {
    expect(parseToolchain(PINNED)).toEqual({
      channel: '1.97.0',
      components: ['clippy', 'rustfmt'],
    });
    expect(parseToolchain('1.97.0\n')).toEqual({ channel: '1.97.0', components: [] });
    expect(parseToolchain('[toolchain\n')).toBeUndefined();
  });
});

describe('toolchainFindings', () => {
  it('accepts an exact release with the editor’s components', () => {
    expect(toolchainFindings('rust-toolchain.toml', PINNED)).toEqual([]);
  });

  it('reports a channel that floats', () => {
    for (const channel of ['stable', '1.97', 'nightly-2026-10-01']) {
      const text = `[toolchain]\nprofile = "minimal"\nchannel = "${channel}"\n`;
      expect(toolchainFindings('rust-toolchain.toml', text)).toEqual([
        {
          rule: 'toolchain/unpinned',
          message: `rust-toolchain.toml pins "${channel}"; pin an exact release, such as channel = "1.97.0".`,
          location: { file: 'rust-toolchain.toml', line: 3 },
        },
      ]);
    }
  });

  it('reports a missing editor component', () => {
    const text = '[toolchain]\nchannel = "1.97.0"\ncomponents = ["clippy"]\n';
    expect(toolchainFindings('a/rust-toolchain.toml', text)).toEqual([
      expect.objectContaining({
        rule: 'toolchain/missing',
        location: { file: 'a/rust-toolchain.toml', line: 3 },
      }),
    ]);
  });
});

describe('toolchainFile', () => {
  it('takes the component’s own file, else the nearest one above it', () => {
    const tracked = new Set(['rust-toolchain.toml', 'apps/desktop/rust-toolchain', 'x/Cargo.toml']);
    expect(toolchainFile('apps/desktop', tracked)).toBe('apps/desktop/rust-toolchain');
    expect(toolchainFile('x', tracked)).toBe('rust-toolchain.toml');
    expect(toolchainFile('.', new Set())).toBeUndefined();
  });
});

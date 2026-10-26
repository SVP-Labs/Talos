import { describe, expect, it } from 'vitest';
import { PY_DEV_TOOLS } from './index.js';
import { toolchainFindings } from './toolchain.js';

describe('toolchainFindings', () => {
  const pins = { ruff: '0.17.2', 'import-linter': '2.15', pytest: '9.1.1' };

  it('accepts every pinned tool at its version, whatever the name’s spelling', () => {
    const installed = new Map([
      ['ruff', '0.17.2'],
      ['import-linter', '2.15'],
      ['pytest', '9.1.1'],
    ]);
    expect(toolchainFindings(pins, installed)).toEqual([]);
  });

  it('reports a tool that is missing or at another version, keyed by name', () => {
    const findings = toolchainFindings(pins, new Map([['ruff', '0.17.1']]));
    expect(findings.map((f) => [f.rule, f.key])).toEqual([
      ['toolchain/mismatch', 'pypi ruff'],
      ['toolchain/missing', 'pypi import-linter'],
      ['toolchain/missing', 'pypi pytest'],
    ]);
    expect(findings[0]?.message).toBe(
      'ruff 0.17.1 is installed but Talos runs 0.17.2, so the editor and the gate may disagree.',
    );
  });

  it('pins exact versions of the Python tools', () => {
    expect(PY_DEV_TOOLS.manager).toBe('pypi');
    for (const version of Object.values(PY_DEV_TOOLS.packages)) {
      expect(version).toMatch(/^\d+(\.\d+)+$/);
    }
  });
});

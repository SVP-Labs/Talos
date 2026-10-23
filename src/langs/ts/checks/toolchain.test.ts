import { describe, expect, it } from 'vitest';
import { toolchainFindings } from './toolchain.js';

describe('toolchainFindings', () => {
  const pinned = { eslint: '10.13.0', knip: '6.42.1', prettier: '3.9.10' };
  const manifest = {
    file: 'apps/web/package.json',
    lines: [
      '{',
      '  "devDependencies": {',
      '    "eslint": "^10.12.0",',
      '    "prettier": "3.9.10"',
      '  }',
      '}',
    ],
  };

  it('reports a tool at another version, or missing, at its package.json line', () => {
    const findings = toolchainFindings(pinned, { eslint: '10.12.0', prettier: '3.9.10' }, manifest);
    expect(findings).toEqual([
      {
        rule: 'toolchain/version',
        message: 'eslint is 10.12.0; Talos pins 10.13.0, which editors and the gate must share.',
        key: 'eslint@10.12.0',
        location: { file: 'apps/web/package.json', line: 3 },
      },
      {
        rule: 'toolchain/version',
        message: 'knip is not installed; Talos pins 6.42.1.',
        key: 'knip@missing',
        location: { file: 'apps/web/package.json', line: 1 },
      },
    ]);
  });

  it('is quiet when every tool matches', () => {
    expect(toolchainFindings(pinned, { ...pinned }, manifest)).toEqual([]);
  });
});

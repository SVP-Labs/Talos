import { describe, expect, it } from 'vitest';
import { bashFor, customFindings, insideRepo } from './custom.js';
import { EngineError } from '../../core/check.js';

const ROOT = '/work/repo';

describe('customFindings', () => {
  it('reads one finding a line and skips blank lines', () => {
    const out = [
      '{"rule": "dead-link", "file": "docs/a.md", "line": 3, "message": "A dead link."}',
      '',
      '{"rule": "E1", "file": "/work/repo/src/x.py", "line": 1, "message": " Too long. ", "extra": 1}',
      '',
    ].join('\n');
    expect(customFindings('links', ROOT, out)).toEqual([
      {
        rule: 'custom/links/dead-link',
        message: 'A dead link.',
        location: { file: 'docs/a.md', line: 3 },
      },
      {
        rule: 'custom/links/E1',
        message: 'Too long.',
        location: { file: 'src/x.py', line: 1 },
      },
    ]);
    expect(customFindings('links', ROOT, '\n\r\n')).toEqual([]);
  });

  it('is an engine error naming the check for any other line', () => {
    expect(() => customFindings('graph', ROOT, 'checking...\n')).toThrow(
      new EngineError('custom check graph: output line 1 is not JSON: checking...'),
    );
    expect(() => customFindings('graph', ROOT, '{"rule": "x", "file": "a", "line": 0}')).toThrow(
      /custom check graph: output line 1 is not \{rule, file, line, message\}/,
    );
    expect(() =>
      customFindings('graph', ROOT, '{"rule": "x y", "file": "a", "line": 1, "message": "m"}'),
    ).toThrow(/must be a rule id/);
    expect(() =>
      customFindings('graph', ROOT, '{"rule": "x", "file": "../a", "line": 1, "message": "m"}'),
    ).toThrow('custom check graph: ../a is not a file in the repository');
  });
});

describe('insideRepo', () => {
  it('makes paths repository-relative with forward slashes', () => {
    expect(insideRepo(ROOT, './src/a.ts')).toBe('src/a.ts');
    expect(insideRepo(ROOT, String.raw`src\b.ts`)).toBe('src/b.ts');
    expect(insideRepo(ROOT, '/work/repo/c.ts')).toBe('c.ts');
  });

  it('refuses paths outside the repository', () => {
    expect(insideRepo(ROOT, '/elsewhere/a.ts')).toBeUndefined();
    expect(insideRepo(ROOT, 'a/../../b')).toBeUndefined();
    expect(insideRepo(ROOT, String.raw`C:\x\a.ts`)).toBeUndefined();
    expect(insideRepo(ROOT, '.')).toBeUndefined();
  });
});

describe('bashFor', () => {
  it('runs bash on Linux and macOS', async () => {
    expect(await bashFor('linux', {})).toBe('bash');
    expect(await bashFor('macos', {})).toBe('bash');
  });

  it("runs Git Bash on Windows, never Windows' own bash.exe", async () => {
    const present = (path: string): Promise<boolean> =>
      Promise.resolve(path === String.raw`D:\Programs\Git\bin\bash.exe`);
    expect(await bashFor('windows', { ProgramFiles: String.raw`D:\Programs` }, present)).toBe(
      String.raw`D:\Programs\Git\bin\bash.exe`,
    );
    expect(await bashFor('windows', {}, () => Promise.resolve(false))).toBe('bash.exe');
  });
});

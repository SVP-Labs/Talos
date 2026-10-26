import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { curlArgs, formatOf, unpackCommand } from './fetch.js';
import { downloadFor, type FileTool, lockedTool, parseLock } from './lockfile.js';
import { installArgs, pypiStamp, venvArgs, venvProgram } from './pypi.js';
import { EngineError } from '../core/check.js';

const SHA = 'a'.repeat(64);

function lockText(tools: unknown): string {
  return JSON.stringify({ runtimes: { python: '3.13.17' }, tools });
}

const linux = { url: 'https://example.com/linux.tar.gz', sha256: SHA, path: 'demo' };

const demo: FileTool = {
  version: '1.0.0',
  kind: 'archive',
  platforms: {
    'linux-x64': linux,
    any: { url: 'https://example.com/any.zip', sha256: SHA, path: 'demo.py' },
  },
};

describe('parseLock', () => {
  it('reads archives, single files, gallery packages and Python tools', () => {
    const lock = parseLock(
      lockText({
        demo,
        py: { version: '2.0', kind: 'pypi', requirements: 'tools/py.txt', bin: 'py' },
      }),
      'tools.lock',
    );
    expect(lockedTool(lock, 'demo').version).toBe('1.0.0');
    expect(lockedTool(lock, 'py').kind).toBe('pypi');
    expect(lock.runtimes.python).toBe('3.13.17');
  });

  it.each([
    ['not JSON', '{', /is not valid JSON/],
    [
      'a bad checksum',
      lockText({
        demo: { ...demo, platforms: { any: { url: 'https://x/y.zip', sha256: 'ABC', path: 'x' } } },
      }),
      /tools\.demo\.platforms\.any\.sha256/,
    ],
    [
      'another protocol',
      lockText({
        demo: { ...demo, platforms: { any: { url: 'ssh://x/y.zip', sha256: SHA, path: 'x' } } },
      }),
      /must be an https URL/,
    ],
    [
      'a path leaving the cache',
      lockText({
        demo: {
          ...demo,
          platforms: { any: { url: 'https://x/y.zip', sha256: SHA, path: '../x' } },
        },
      }),
      /stays inside/,
    ],
    [
      'an absolute path',
      lockText({
        demo: {
          ...demo,
          platforms: { any: { url: 'https://x/y.zip', sha256: SHA, path: 'C:/x' } },
        },
      }),
      /stays inside/,
    ],
    [
      'an unknown platform',
      lockText({
        demo: {
          ...demo,
          platforms: { 'sunos-x64': { url: 'https://x/y.zip', sha256: SHA, path: 'x' } },
        },
      }),
      /invalid at tools\.demo/,
    ],
    ['no downloads', lockText({ demo: { ...demo, platforms: {} } }), /at least one download/],
    ['an unknown kind', lockText({ demo: { ...demo, kind: 'npm' } }), /invalid at tools\.demo/],
    [
      'a floating Python',
      JSON.stringify({ runtimes: { python: '3.13' }, tools: {} }),
      /exact version/,
    ],
  ])('refuses %s', (_what, text, message) => {
    expect(() => parseLock(text, 'tools.lock')).toThrow(EngineError);
    expect(() => parseLock(text, 'tools.lock')).toThrow(message);
  });

  it('names a tool the lock lacks', () => {
    const lock = parseLock(lockText({}), 'tools.lock');
    expect(() => lockedTool(lock, 'gitleaks')).toThrow('gitleaks is not in tools.lock');
  });
});

describe('downloadFor', () => {
  it("prefers this machine's download, then the one for any machine", () => {
    expect(downloadFor(demo, 'demo', 'linux-x64').path).toBe('demo');
    expect(downloadFor(demo, 'demo', 'win32-x64').path).toBe('demo.py');
    expect(downloadFor(demo, 'demo', 'freebsd-x64').path).toBe('demo.py');
  });

  it('fails for a machine nothing serves', () => {
    const linuxOnly: FileTool = {
      ...demo,
      platforms: { 'linux-x64': linux },
    };
    expect(() => downloadFor(linuxOnly, 'demo', 'darwin-arm64')).toThrow(
      'tools.lock has no demo 1.0.0 for darwin-arm64',
    );
  });
});

describe('the shipped tools.lock', () => {
  it('pins every tool the checks ask for, for Linux at least', async () => {
    const text = await readFile(new URL('../../tools.lock', import.meta.url), 'utf8');
    const lock = parseLock(text, 'tools.lock');
    const names = [
      'actionlint',
      'cargo-llvm-cov',
      'cargo-machete',
      'cargo-mutants',
      'cargo-nextest',
      'gitleaks',
      'hadolint',
      'hererocks',
      'lua-language-server',
      'osv-scanner',
      'psscriptanalyzer',
      'semgrep',
      'shellcheck',
      'stylua',
      'uv',
      'zizmor',
    ];
    for (const name of names) {
      const tool = lockedTool(lock, name);
      if (tool.kind !== 'pypi') {
        expect(downloadFor(tool, name, 'linux-x64').sha256).toHaveLength(64);
      }
    }
    const requirements = await readFile(
      new URL('../../tools/semgrep.txt', import.meta.url),
      'utf8',
    );
    expect(requirements).toContain('semgrep==1.182.1');
    expect(requirements).toContain('--hash=sha256:');
  });
});

describe('fetching', () => {
  it('unpacks by kind, then by extension', () => {
    expect(formatOf('binary', 'https://x/tool')).toBe('file');
    expect(formatOf('psgallery', 'https://x/pkg.nupkg')).toBe('zip');
    expect(formatOf('archive', 'https://x/a.zip')).toBe('zip');
    expect(formatOf('archive', 'https://x/a.tar.gz')).toBe('tar');
    expect(formatOf('archive', 'https://x/a.tar.xz')).toBe('tar');
    expect(() => formatOf('archive', 'https://x/a.7z')).toThrow(/no way to unpack/);
  });

  it("unpacks with Windows' own tar there, and unzip or tar elsewhere", () => {
    expect(
      unpackCommand('zip', 'a.zip', 'out', { platform: 'win32', systemRoot: 'D:\\Win' }),
    ).toEqual({
      command: 'D:\\Win\\System32\\tar.exe',
      args: ['-xf', 'a.zip', '-C', 'out'],
    });
    expect(unpackCommand('zip', 'a.zip', 'out', { platform: 'linux' }).command).toBe('unzip');
    expect(unpackCommand('tar', 'a.tgz', 'out', { platform: 'darwin' })).toEqual({
      command: 'tar',
      args: ['-xf', 'a.tgz', '-C', 'out'],
    });
  });

  it('downloads over https only, failing on an HTTP error', () => {
    const args = curlArgs('https://x/y', 'out');
    expect(args).toContain('--fail');
    expect(args.slice(-3)).toEqual(['--output', 'out', 'https://x/y']);
    expect(args.join(' ')).toContain('--proto-redir =https');
  });
});

describe('Python tools', () => {
  it('builds a relocatable environment on the pinned Python and installs only hashed pins', () => {
    expect(venvArgs('3.13.17', '/w/venv')).toEqual(
      expect.arrayContaining(['--relocatable', '--managed-python', '3.13.17', '/w/venv']),
    );
    const install = installArgs('/w/venv', '/t/req.txt', 'linux');
    expect(install).toEqual(expect.arrayContaining(['--require-hashes', ':all:', '/t/req.txt']));
    expect(venvProgram('/v', 'semgrep', 'linux')).toMatch(/[/\\]v[/\\]bin[/\\]semgrep$/);
    expect(venvProgram('/v', 'semgrep', 'win32')).toMatch(/Scripts[/\\]semgrep\.exe$/);
  });

  it('stamps an environment with the Python and requirements it was built from', () => {
    expect(pypiStamp('3.13.17', 'a')).not.toBe(pypiStamp('3.13.16', 'a'));
    expect(pypiStamp('3.13.17', 'a')).not.toBe(pypiStamp('3.13.17', 'b'));
    expect(pypiStamp('3.13.17', 'a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

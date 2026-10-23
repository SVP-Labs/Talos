import { describe, expect, it } from 'vitest';
import { declaredRuntimes, isDeclaringFile } from './declarations.js';
import { toolsLockDeclarations } from './tools-lock.js';
import {
  composerFile,
  goModFile,
  nodeVersionFile,
  pythonVersionFile,
  rustToolchainFile,
} from './version-files.js';
import { EngineError } from '../../core/check.js';

describe('node version files', () => {
  it('pins a release with or without its v', () => {
    expect(nodeVersionFile('.nvmrc', '# the LTS\nv22.12.0\n')).toEqual([
      {
        runtime: 'node',
        file: '.nvmrc',
        line: 2,
        written: 'v22.12.0',
        version: '22.12.0',
        exactness: 'exact',
      },
    ]);
    expect(nodeVersionFile('.node-version', '24.22.1')[0]?.exactness).toBe('exact');
  });

  it('floats a major, an alias or a range', () => {
    expect(nodeVersionFile('.nvmrc', '22\n')[0]).toMatchObject({
      version: '22',
      exactness: 'floating',
    });
    expect(nodeVersionFile('.nvmrc', 'lts/*')[0]).toEqual({
      runtime: 'node',
      file: '.nvmrc',
      line: 1,
      written: 'lts/*',
      exactness: 'floating',
    });
    expect(nodeVersionFile('.nvmrc', '>=22.12.0')[0]?.version).toBeUndefined();
    expect(nodeVersionFile('.nvmrc', '\n# nothing\n')).toEqual([]);
  });
});

describe('.python-version', () => {
  it('reads each CPython line and system, and leaves other interpreters alone', () => {
    const text = ['3.13.1', 'cpython@3.12', 'pypy3.10-7.3.17', '3.14t', 'system'].join('\n');
    expect(pythonVersionFile('.python-version', text)).toEqual([
      {
        runtime: 'python',
        file: '.python-version',
        line: 1,
        written: '3.13.1',
        version: '3.13.1',
        exactness: 'exact',
      },
      {
        runtime: 'python',
        file: '.python-version',
        line: 2,
        written: 'cpython@3.12',
        version: '3.12',
        exactness: 'floating',
      },
      {
        runtime: 'python',
        file: '.python-version',
        line: 4,
        written: '3.14t',
        version: '3.14',
        exactness: 'floating',
      },
      {
        runtime: 'python',
        file: '.python-version',
        line: 5,
        written: 'system',
        exactness: 'floating',
      },
    ]);
  });
});

describe('rust toolchain files', () => {
  it('reads the channel of the TOML file on its line', () => {
    const text = '[toolchain]\nchannel = "1.99.1"\ncomponents = ["rustfmt"]\n';
    expect(rustToolchainFile('rust-toolchain.toml', text)).toEqual([
      {
        runtime: 'rust',
        file: 'rust-toolchain.toml',
        line: 2,
        written: '1.99.1',
        version: '1.99.1',
        exactness: 'exact',
      },
    ]);
  });

  it('reads the legacy one-line file, and floats a channel name or none', () => {
    expect(rustToolchainFile('rust-toolchain', '1.98\n')[0]).toMatchObject({
      version: '1.98',
      exactness: 'floating',
    });
    expect(rustToolchainFile('rust-toolchain', 'nightly-2026-10-01\n')[0]).toMatchObject({
      written: 'nightly-2026-10-01',
      exactness: 'floating',
    });
    expect(
      rustToolchainFile('rust-toolchain.toml', '[toolchain]\nprofile = "minimal"\n')[0],
    ).toMatchObject({
      written: 'no channel',
      line: 1,
    });
    expect(rustToolchainFile('rust-toolchain.toml', '[toolchain\n')[0]?.written).toBe('no channel');
  });
});

describe('go.mod', () => {
  it('reads the toolchain line, not the go line', () => {
    const text = 'module example.com/app\n\ngo 1.25\n\ntoolchain go1.27.3\n';
    expect(goModFile('go.mod', text)).toEqual([
      {
        runtime: 'go',
        file: 'go.mod',
        line: 5,
        written: 'go1.27.3',
        version: '1.27.3',
        exactness: 'exact',
      },
    ]);
    expect(goModFile('go.mod', 'module m\ngo 1.25\n')).toEqual([]);
    expect(goModFile('go.mod', 'toolchain default\n')[0]).toMatchObject({ exactness: 'floating' });
    expect(goModFile('go.mod', 'toolchain go1.28rc1\n')[0]).toMatchObject({
      version: '1.28rc1',
      exactness: 'floating',
    });
  });
});

describe('composer.json', () => {
  it("reads config.platform.php as a minimum, on the php key's line", () => {
    const text =
      '{\n  "require": { "php": "^8.2" },\n  "config": {\n    "platform": {\n      "php": "8.2.0"\n    }\n  }\n}\n';
    expect(composerFile('composer.json', text)).toEqual([
      {
        runtime: 'php',
        file: 'composer.json',
        line: 5,
        written: '8.2.0',
        version: '8.2.0',
        exactness: 'minimum',
      },
    ]);
  });

  it('declares nothing without a platform PHP or valid JSON', () => {
    expect(composerFile('composer.json', '{"require": {"php": "^8.4"}}')).toEqual([]);
    expect(composerFile('composer.json', '{"config": {"platform": {"php": "dev"}}}')).toEqual([]);
    expect(composerFile('composer.json', '{')).toEqual([]);
  });
});

describe('tools.lock', () => {
  const lock = JSON.stringify(
    {
      tools: {
        gitleaks: { version: '8.21.2' },
        python: { version: '3.13.1', runtime: true },
        stylua: { version: '0.25.1', runtime: false },
        lua54: { version: 'v5.4.7', runtime: 'lua' },
      },
    },
    undefined,
    2,
  );

  it('reads the entries marked as runtimes, on their own lines', () => {
    expect(toolsLockDeclarations('tools.lock', lock)).toEqual([
      {
        runtime: 'python',
        file: 'tools.lock',
        line: 6,
        written: '3.13.1',
        version: '3.13.1',
        exactness: 'exact',
      },
      {
        runtime: 'lua',
        file: 'tools.lock',
        line: 14,
        written: 'lua54 5.4.7',
        version: '5.4.7',
        exactness: 'exact',
      },
    ]);
  });

  it('declares nothing for a file of another shape, and refuses an unknown runtime', () => {
    expect(toolsLockDeclarations('tools.lock', 'just text')).toEqual([]);
    expect(toolsLockDeclarations('tools.lock', ': [')).toEqual([]);
    expect(() =>
      toolsLockDeclarations('tools.lock', 'tools:\n  erlang: { version: 27.1.2, runtime: true }\n'),
    ).toThrow(EngineError);
  });
});

describe('declaredRuntimes', () => {
  it('reads each declaring file by its name, and the root tools.lock only', () => {
    expect(
      [
        'Dockerfile',
        'docker/api.Dockerfile',
        'Dockerfile.prod',
        'ops/Containerfile',
        'a/.nvmrc',
        'tools.lock',
      ].map(isDeclaringFile),
    ).toEqual([true, true, true, true, true, true]);
    expect(
      ['Dockerfile.dockerignore', 'vendor/tools.lock', 'package.json', 'docs/docker-guide.md'].map(
        isDeclaringFile,
      ),
    ).toEqual([false, false, false, false]);
    const files = new Map([
      ['Dockerfile', 'FROM php:8.4.26-fpm\n'],
      ['web/.nvmrc', '22.12.0\n'],
      ['README.md', 'FROM php:5.6.0\n'],
      ['sub/tools.lock', '{"tools": {"python": {"version": "3.9.0", "runtime": true}}}'],
    ]);
    expect(declaredRuntimes(files).map((d) => `${d.file}:${d.runtime}@${d.version ?? ''}`)).toEqual(
      ['Dockerfile:php@8.4.26', 'web/.nvmrc:node@22.12.0'],
    );
  });
});

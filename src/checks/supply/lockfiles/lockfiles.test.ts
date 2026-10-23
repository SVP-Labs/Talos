import { describe, expect, it } from 'vitest';
import { lockfiles, parseLockfile } from './index.js';
import { npmSource, shownSource } from './locked.js';
import { EngineError } from '../../../core/check.js';
import { repoFacts } from '../../../repo/facts.js';

// Recorded from pnpm 10.28, npm 10.9, Yarn 1.22 and 4.9, uv 0.11, Poetry 2.2, Composer 2 and
// Cargo 1.97, trimmed; the git repositories were local ones.
const PNPM = `lockfileVersion: '9.0'

packages:

  '@isaacs/string-locale-compare@1.1.0':
    resolution: {integrity: sha512-SQ7K}

  gitpkg@git+file:///work/gitpkg#c44855938e715b615bc3e754ce13580b886f5fd6:
    resolution: {commit: c44855938e715b615bc3e754ce13580b886f5fd6, repo: file:///work/gitpkg, type: git}
    version: 1.0.0

  is-odd@3.0.1:
    resolution: {integrity: sha512-CQpn}

  remote@https://example.com/remote-2.0.0.tgz:
    resolution: {tarball: https://example.com/remote-2.0.0.tgz}
    version: 2.0.0

  linked@file:packages/linked:
    resolution: {directory: packages/linked, type: directory}
    version: 0.1.0
`;

const NPM = JSON.stringify({
  name: 'np',
  lockfileVersion: 3,
  packages: {
    '': { name: 'np', version: '1.0.0' },
    'node_modules/@isaacs/string-locale-compare': {
      version: '1.1.0',
      resolved:
        'https://registry.npmjs.org/@isaacs/string-locale-compare/-/string-locale-compare-1.1.0.tgz',
      license: 'ISC',
    },
    'node_modules/gitpkg': {
      version: '1.0.0',
      resolved: 'git+ssh://git@example.com/gitpkg.git#c44855938e715b615bc3e754ce13580b886f5fd6',
    },
    'node_modules/remote': { version: '2.0.0', resolved: 'https://example.com/remote.tgz' },
    'node_modules/@acme/own': { resolved: 'packages/own', link: true },
    'packages/own': { name: '@acme/own', version: '0.1.0' },
  },
});

const YARN_V1 = `# yarn lockfile v1


"@isaacs/string-locale-compare@1.1.0":
  version "1.1.0"
  resolved "https://registry.yarnpkg.com/@isaacs/string-locale-compare/-/string-locale-compare-1.1.0.tgz#291c227e93fd407a96ecd59879a35809120e432b"

"gitpkg@git+file:///work/gitpkg":
  version "1.0.0"
  resolved "git+file:///work/gitpkg#c44855938e715b615bc3e754ce13580b886f5fd6"

is-number@^6.0.0, is-number@^6.0.1:
  version "6.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"
`;

const YARN_BERRY = `__metadata:
  version: 8
  cacheKey: 10c0

"is-odd@https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz":
  version: 3.0.1
  resolution: "is-odd@https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz"

"left-pad@npm:1.3.0":
  version: 1.3.0
  resolution: "left-pad@npm:1.3.0"

"left-pad@patch:left-pad@npm%3A1.3.0#~/.yarn/patches/left-pad.patch":
  version: 1.3.0
  resolution: "left-pad@patch:left-pad@npm%3A1.3.0#~/.yarn/patches/left-pad.patch::version=1.3.0"

"tarpkg@file:./tarpkg-2.0.0.tgz::locator=y4%40workspace%3A.":
  version: 2.0.0
  resolution: "tarpkg@file:./tarpkg-2.0.0.tgz#./tarpkg-2.0.0.tgz::hash=130275&locator=y4%40workspace%3A."

"gitpkg@https://github.com/acme/gitpkg.git#commit=abc123":
  version: 1.0.0
  resolution: "gitpkg@https://github.com/acme/gitpkg.git#commit=abc123"

"y4@workspace:.":
  version: 0.0.0-use.local
  resolution: "y4@workspace:."
`;

const UV = `version = 1
revision = 3

[options]
exclude-newer-span = "P1D"

[[package]]
name = "idna"
version = "3.10"
source = { url = "https://files.pythonhosted.org/packages/76/c6/idna-3.10-py3-none-any.whl" }

[[package]]
name = "pygit"
version = "0.3.0"
source = { git = "https://token:secret@example.com/pygit?rev=main#32c63364" }

[[package]]
name = "six"
version = "1.17.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "private"
version = "1.0"
source = { registry = "https://pypi.example.com/simple" }

[[package]]
name = "uvp"
version = "0.1.0"
source = { virtual = "." }
`;

const POETRY = `[[package]]
name = "idna"
version = "3.10"

[package.source]
type = "url"
url = "https://files.pythonhosted.org/packages/76/c6/idna-3.10-py3-none-any.whl"

[[package]]
name = "pygit"
version = "0.3.0"

[package.source]
type = "git"
url = "https://example.com/pygit.git"
reference = "HEAD"
resolved_reference = "32c63364239f8572683df5dcdc2f7c6c7394ae59"

[[package]]
name = "six"
version = "1.17.0"

[metadata]
lock-version = "2.1"
`;

const COMPOSER = JSON.stringify({
  packages: [
    {
      name: 'acme/phpgit',
      version: 'dev-master',
      source: { type: 'git', url: '/work/phpgit', reference: '43c75f3d' },
      license: ['MIT'],
    },
    {
      name: 'psr/log',
      version: '3.0.2',
      source: { type: 'git', url: 'https://github.com/php-fig/log.git', reference: 'f16e1d58' },
      dist: { type: 'zip', url: 'https://api.github.com/repos/php-fig/log/zipball/f16e1d58' },
      'notification-url': 'https://packagist.org/downloads/',
      license: ['MIT'],
    },
  ],
  'packages-dev': [
    { name: 'acme/tools', version: 'dev-main', dist: { type: 'path', url: 'tools' } },
  ],
});

const CARGO = `version = 4

[[package]]
name = "itoa"
version = "1.0.11"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "rs"
version = "0.1.0"

[[package]]
name = "rsgit"
version = "0.2.0"
source = "git+file:///work/rsgit#bee88911f58f78c6f560c302d1d87e0235a161ec"
`;

const summary = (path: string, text: string): string[] =>
  parseLockfile(path, text).map((p) => {
    const where = p.source.kind === 'git' || p.source.kind === 'url' ? ` ${p.source.from}` : '';
    const scope = p.source.kind === 'registry' && !p.source.public ? ' private' : '';
    return `${p.name}@${p.version} ${p.source.kind}${scope}${where}`;
  });

describe('parseLockfile', () => {
  it('reads pnpm-lock.yaml', () => {
    expect(summary('pnpm-lock.yaml', PNPM)).toEqual([
      '@isaacs/string-locale-compare@1.1.0 registry',
      'gitpkg@1.0.0 git file:///work/gitpkg',
      'is-odd@3.0.1 registry',
      'remote@2.0.0 url https://example.com/remote-2.0.0.tgz',
      'linked@0.1.0 local',
    ]);
  });

  it('reads package-lock.json with its licences', () => {
    expect(summary('app/package-lock.json', NPM)).toEqual([
      '@isaacs/string-locale-compare@1.1.0 registry',
      'gitpkg@1.0.0 git git+ssh://example.com/gitpkg.git#c44855938e715b615bc3e754ce13580b886f5fd6',
      'remote@2.0.0 url https://example.com/remote.tgz',
      '@acme/own@0.0.0 local',
      '@acme/own@0.1.0 local',
    ]);
    expect(parseLockfile('package-lock.json', NPM)[0]?.licences).toEqual(['ISC']);
  });

  it('reads a version 1 package-lock.json tree', () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: { version: '1.0.0', dependencies: { b: { version: 'github:acme/b#abc' } } },
      },
    });
    expect(summary('package-lock.json', v1)).toEqual([
      'a@1.0.0 registry',
      'b@github:acme/b#abc git github:acme/b#abc',
    ]);
  });

  it('reads both yarn.lock formats', () => {
    expect(summary('yarn.lock', YARN_V1)).toEqual([
      '@isaacs/string-locale-compare@1.1.0 registry',
      'gitpkg@1.0.0 git git+file:///work/gitpkg#c44855938e715b615bc3e754ce13580b886f5fd6',
      'is-number@6.0.0 registry',
    ]);
    expect(summary('yarn.lock', YARN_BERRY)).toEqual([
      'is-odd@3.0.1 registry',
      'left-pad@1.3.0 registry',
      'left-pad@1.3.0 registry',
      'tarpkg@2.0.0 url ./tarpkg-2.0.0.tgz',
      'gitpkg@1.0.0 git https://github.com/acme/gitpkg.git#commit=abc123',
      'y4@0.0.0-use.local local',
    ]);
  });

  it('reads uv.lock and poetry.lock, credentials and queries left out', () => {
    expect(summary('uv.lock', UV)).toEqual([
      'idna@3.10 url https://files.pythonhosted.org/packages/76/c6/idna-3.10-py3-none-any.whl',
      'pygit@0.3.0 git https://example.com/pygit#32c63364',
      'six@1.17.0 registry',
      'private@1.0 registry private',
      'uvp@0.1.0 local',
    ]);
    expect(summary('poetry.lock', POETRY)).toEqual([
      'idna@3.10 url https://files.pythonhosted.org/packages/76/c6/idna-3.10-py3-none-any.whl',
      'pygit@0.3.0 git https://example.com/pygit.git',
      'six@1.17.0 registry',
    ]);
  });

  it('reads composer.lock: Packagist, a VCS repository and a path repository', () => {
    expect(summary('composer.lock', COMPOSER)).toEqual([
      'acme/phpgit@dev-master git /work/phpgit',
      'psr/log@3.0.2 registry',
      'acme/tools@dev-main local',
    ]);
    expect(parseLockfile('composer.lock', COMPOSER)[1]?.licences).toEqual(['MIT']);
  });

  it('reads Cargo.lock', () => {
    expect(summary('crates/Cargo.lock', CARGO)).toEqual([
      'itoa@1.0.11 registry',
      'rs@0.1.0 local',
      'rsgit@0.2.0 git file:///work/rsgit#bee88911f58f78c6f560c302d1d87e0235a161ec',
    ]);
  });

  it('throws an engine error for a lockfile it cannot read', () => {
    expect(() => parseLockfile('Cargo.lock', 'package = [')).toThrow(EngineError);
    expect(() => parseLockfile('package-lock.json', '{')).toThrow(/package-lock.json/);
  });
});

describe('lockfile helpers', () => {
  it('finds tracked lockfiles anywhere', () => {
    const facts = repoFacts(['a/Cargo.lock', 'pnpm-lock.yaml', 'src/x.ts', 'vendor/uv.lock'], []);
    expect(lockfiles(facts)).toEqual(['a/Cargo.lock', 'pnpm-lock.yaml', 'vendor/uv.lock']);
  });

  it('tells a registry tarball from another URL', () => {
    const url = 'https://registry.npmjs.org/@a/b/-/b-1.0.0.tgz';
    expect(npmSource('@a/b', '1.0.0', url)).toEqual({ kind: 'registry', public: true });
    expect(npmSource('b', '1.0.0', 'https://npm.example.com/b/-/b-1.0.0.tgz')).toEqual({
      kind: 'registry',
      public: false,
    });
    expect(npmSource('b', '1.0.0', 'file:../b.tgz')).toEqual({ kind: 'url', from: '../b.tgz' });
    expect(npmSource('b', '1.0.0', 'file:../b')).toEqual({ kind: 'local' });
    expect(npmSource('b', '1.0.0', 'not a url')).toEqual({ kind: 'url', from: 'not a url' });
  });

  it('keeps credentials and queries out of a shown source', () => {
    expect(shownSource('https://user:pw@example.com/x.tgz?token=1#frag')).toBe(
      'https://example.com/x.tgz#frag',
    );
  });
});

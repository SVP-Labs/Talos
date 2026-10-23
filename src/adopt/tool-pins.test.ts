import { describe, expect, it } from 'vitest';
import { startDraft } from './draft.js';
import { allowsOlderPhp, composerSettings, isLaravel } from './php.js';
import { npmLockStep, toolPins, TYPES_NODE } from './tool-pins.js';
import type { Component, Lang } from '../core/check.js';
import type { DevTools, Pack } from '../core/pack.js';
import { PHP_DEV_TOOLS } from '../langs/php/toolchain.js';

function pack(lang: Lang, devTools: DevTools): Pack {
  return { name: lang, lang, checks: [], devTools };
}

const PY = pack('py', { manager: 'pypi', packages: { ruff: '0.17.2' } });
const TS = pack('ts', { manager: 'npm', packages: { eslint: '10.13.0' } });

function component(lang: Lang, root: string): Component {
  return { lang, root, os: ['linux'] };
}

function pinned(texts: Record<string, string>, components: Component[], packs: Pack[]) {
  const draft = startDraft(Object.keys(texts), (path) => texts[path]);
  toolPins(draft, components, packs);
  return { ...draft.done(), read: draft.read };
}

describe('toolPins', () => {
  it('pins Python tools in pyproject or requirements-dev.in, and names the next step', () => {
    const rust = pack('rust', { manager: 'cargo', packages: { x: '1' } });
    const out = pinned(
      { 'api/pyproject.toml': '[project]\nname = "a"\n' },
      [component('py', 'api'), component('py', 'tools'), component('rust', 'desk')],
      [PY, rust],
    );
    expect(out.write.map((f) => f.path)).toEqual(['api/pyproject.toml', 'tools/requirements-dev.in']);
    expect(out.next).toEqual([
      'in api: uv lock',
      'in tools: uv pip compile --generate-hashes requirements-dev.in -o requirements-dev.txt',
      'in desk: pin x by hand',
    ]);
  });

  it('pins where the install reads: requirements-dev.in beside hashed requirements', () => {
    const texts = {
      'pyproject.toml': '[project]\nname = "a"\n',
      'requirements.txt': 'x==1 --hash=sha256:00\n',
      'requirements-dev.in': '# Tests\npytest\n\nhypothesis\n',
    };
    const out = pinned(texts, [component('py', '.')], [PY]);
    expect(out.read('requirements-dev.in')).toBe('# Tests\npytest\n\nhypothesis\nruff==0.17.2\n');
    const locked = pinned({ ...texts, 'uv.lock': '' }, [component('py', '.')], [PY]);
    expect(locked.write.map((f) => f.path)).toEqual(['pyproject.toml']);
  });

  it('says what to do when a manifest is missing or unusual, and leaves pinned ones alone', () => {
    expect(pinned({}, [component('ts', 'web')], [TS]).next).toEqual([
      'in web: add a package.json Talos can read, then rerun',
    ]);
    const odd = pinned(
      { 'pyproject.toml': 'dependency-groups.dev = []\n' },
      [component('py', '.')],
      [PY],
    );
    expect(odd.next[0]).toMatch(/pin the dev tools by hand/);
    const done = {
      'pyproject.toml': '[dependency-groups]\ndev = ["ruff==0.17.2"]\n',
      'package.json': `{"devDependencies":{"eslint":"10.13.0","@types/node":"^24"}}`,
    };
    const out = pinned(done, [component('py', '.'), component('ts', '.')], [PY, TS]);
    expect(out.write).toEqual([]);
  });

  it("adds @types/node when the project has none, and drops package.json's prettier key", () => {
    const out = pinned(
      { 'package.json': '{\n  "prettier": { "semi": false },\n  "dependencies": {}\n}\n' },
      [component('ts', '.')],
      [TS],
    );
    expect(JSON.parse(out.read('package.json') ?? '')).toEqual({
      dependencies: {},
      devDependencies: { '@types/node': TYPES_NODE, eslint: '10.13.0' },
    });
    expect(out.next).toEqual(['in .: pnpm install --lockfile-only, and commit pnpm-lock.yaml']);
  });

  it('pins nothing for the Lua tree, whose tools come from Talos itself', () => {
    const lua = pack('lua', { manager: 'luarocks', packages: { busted: '2.3.0-1' } });
    expect(pinned({}, [component('lua', '.')], [lua])).toMatchObject({ write: [], next: [] });
  });

  it('refreshes the lockfile where it lives, up to the root', () => {
    expect(npmLockStep('apps/web', ['package-lock.json'])).toBe(
      'in .: npm install --package-lock-only',
    );
    expect(npmLockStep('apps/web', ['apps/yarn.lock'])).toBe(
      'in apps: yarn install --mode update-lockfile',
    );
    expect(npmLockStep('web', [])).toMatch(/commit pnpm-lock.yaml/);
  });
});

describe('composer.json', () => {
  const php = pack('php', PHP_DEV_TOOLS);

  it('pins Larastan only beside Laravel, and sets what the PHP tools need', () => {
    const text = JSON.stringify({
      require: { php: '>=8.1', 'laravel/framework': '^12' },
      'require-dev': { 'phpstan/extension-installer': '^1' },
      config: { 'allow-plugins': { 'phpstan/extension-installer': true, 'x/y': false } },
    });
    const out = pinned({ 'composer.json': text }, [component('php', '.')], [php]);
    const manifest = JSON.parse(out.read('composer.json') ?? '');
    expect(manifest.require).toEqual({ php: '^8.4', 'laravel/framework': '^12' });
    expect(manifest['require-dev']).toHaveProperty('larastan/larastan');
    expect(manifest['require-dev']).not.toHaveProperty('phpstan/extension-installer');
    expect(manifest.config['allow-plugins']).toEqual({
      'x/y': false,
      'pestphp/pest-plugin': true,
      'infection/extension-installer': true,
    });
    expect(out.next).toEqual(['in .: composer update --lock']);
    const plain = pinned({ 'composer.json': '{}' }, [component('php', '.')], [php]);
    expect(JSON.parse(plain.read('composer.json') ?? '')['require-dev']).not.toHaveProperty(
      'larastan/larastan',
    );
  });

  it('keeps settings that already hold', () => {
    const manifest = {
      require: { php: '^8.4 || ^8.5' },
      config: {
        'allow-plugins': { 'pestphp/pest-plugin': true, 'infection/extension-installer': true },
      },
    };
    expect(composerSettings(manifest)).toBe(manifest);
    const all = { require: { php: '8.4.*' }, config: { 'allow-plugins': true } };
    expect(composerSettings(all)).toBe(all);
    expect(isLaravel({ 'require-dev': { 'laravel/framework': '^12' } })).toBe(true);
    expect(isLaravel({})).toBe(false);
  });

  it('reads Composer constraints', () => {
    expect(allowsOlderPhp('^8.2')).toBe(true);
    expect(allowsOlderPhp('^8.3 | ^8.4')).toBe(true);
    expect(allowsOlderPhp('>=8.4, <9')).toBe(false);
    expect(allowsOlderPhp('~8.5.0')).toBe(false);
    expect(allowsOlderPhp('not a constraint')).toBeUndefined();
    expect(composerSettings({ require: { php: 'dev-main' } })).toMatchObject({
      require: { php: 'dev-main' },
    });
  });
});

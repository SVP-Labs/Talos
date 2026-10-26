import { beforeAll, describe, expect, it } from 'vitest';
import { governWith, onOff } from './govern.js';
import type { Io } from './io.js';
import { main } from './main.js';
import { newWith } from './new.js';
import type { GovernAssets } from '../govern/govern.js';
import { loadTemplates } from '../govern/templates.js';
import { freshWorld, worldApi } from '../govern/test/world.js';

let assets: GovernAssets;
beforeAll(async () => {
  assets = { caller: 'name: talos\n', codeowners: '* @OWNER\n', templates: await loadTemplates() };
});

function io(): Io & { stdout: string; stderr: string } {
  const out = {
    cwd: '/nowhere',
    env: { GITHUB_TOKEN: 'token' },
    stdout: '',
    stderr: '',
    out: (text: string) => {
      out.stdout += text;
    },
    err: (text: string) => {
      out.stderr += text;
    },
  };
  return out;
}

describe('talos govern', () => {
  it('governs the named repository and prints compact JSON', async () => {
    const world = freshWorld();
    const run = governWith({ fetch: worldApi(world).fetch, assets: () => Promise.resolve(assets) });
    const term = io();
    expect(await run(['SVP-Labs/demo', '--agents', 'on', '--json'], term)).toBe(0);
    const output = JSON.parse(term.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      schema: 'talos.govern/1',
      repo: 'SVP-Labs/demo',
      channel: 'evaluate',
      dryRun: false,
      ok: true,
      manual: { total: 1 },
    });
    expect(term.stdout.split('\n')).toHaveLength(2);
    expect(world.properties.get('talos-agents')).toBe('true');
  });

  it('prints one line per step for a person, and plans only on --dry-run', async () => {
    const world = freshWorld();
    const run = governWith({ fetch: worldApi(world).fetch, assets: () => Promise.resolve(assets) });
    const term = io();
    expect(await run(['SVP-Labs/demo', '--dry-run'], term)).toBe(0);
    expect(term.stdout).toMatch(/^talos govern: would govern SVP-Labs\/demo at evaluate\n/);
    expect(term.stdout).toContain('~ ruleset:talos-merge-queue');
    expect(world.alerts).toBe(false);
  });

  it('exits 1 for a token that is not the owner', async () => {
    const run = governWith({
      fetch: worldApi(freshWorld(), 'someone').fetch,
      assets: () => Promise.resolve(assets),
    });
    const term = io();
    expect(await run(['SVP-Labs/demo'], term)).toBe(1);
    expect(term.stderr).toMatch(/runs as the owner \(SvenPGH\)/);
  });

  it('exits 1 when a step fails', async () => {
    const world = freshWorld();
    const api = worldApi(world);
    api.routes.unshift({
      method: 'PUT',
      path: /vulnerability-alerts$/,
      reply: () => ({ status: 403, json: {} }),
    });
    const term = io();
    const run = governWith({ fetch: api.fetch, assets: () => Promise.resolve(assets) });
    expect(await run(['SVP-Labs/demo', '--json'], term)).toBe(1);
    expect(JSON.parse(term.stdout)).toMatchObject({ ok: false });
  });

  it('refuses bad flags as usage errors before touching GitHub', async () => {
    const term = io();
    expect(await main(['govern', 'not-a-repo'], term)).toBe(3);
    expect(await main(['govern', 'a/b', '--channel', 'beta'], term)).toBe(3);
    expect(await main(['govern', 'a/b', '--agents', 'maybe'], term)).toBe(3);
    expect(await main(['govern', 'a/b', 'c/d'], term)).toBe(3);
    expect(onOff('true', 'x')).toBe(true);
    expect(onOff('off', 'x')).toBe(false);
    expect(onOff(undefined, 'x')).toBeUndefined();
  });
});

describe('talos new', () => {
  it('creates the repository, records its prefix and governs it', async () => {
    const world = freshWorld();
    world.exists = false;
    world.files.clear();
    const run = newWith({
      fetch: worldApi(world).fetch,
      assets: () => Promise.resolve(assets),
      sleep: () => Promise.resolve(),
    });
    const term = io();
    expect(await run(['demo', '--prefix', 'DM', '--json'], term)).toBe(0);
    expect(world.exists).toBe(true);
    expect(world.files.get('talos.yml')).toBe('name: demo\nprefix: DM\n');
    expect(JSON.parse(term.stdout)).toMatchObject({ schema: 'talos.govern/1', ok: true });
  });

  it('refuses a prefix in use, a taken name, and stays put on --dry-run', async () => {
    const world = freshWorld();
    world.files.set('talos.yml', 'name: demo\nprefix: DM\n');
    const fetch = worldApi(world).fetch;
    const run = newWith({ fetch, assets: () => Promise.resolve(assets) });
    const term = io();
    expect(await run(['demo', '--prefix', 'X'], term)).toBe(1);
    expect(term.stderr).toMatch(/exists already/);
    expect(await run(['other', '--prefix', 'DM'], term)).toBe(1);
    expect(term.stderr).toMatch(/prefix DM is in use by SVP-Labs\/demo/);
    expect(await run(['other', '--prefix', 'OT', '--dry-run'], term)).toBe(0);
    expect(term.stdout).toContain('would create SVP-Labs/other');
  });

  it('checks its arguments', async () => {
    const term = io();
    expect(await main(['new'], term)).toBe(3);
    expect(await main(['new', 'a b', '--prefix', 'A'], term)).toBe(3);
    expect(await main(['new', 'ok', '--prefix', 'lower'], term)).toBe(3);
    expect(await main(['new', 'ok'], term)).toBe(3);
  });
});

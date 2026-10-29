import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from './load.js';

const HEAD = parseConfig('name: Head\nprefix: H\n');

async function checkout(talosYml?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talos-load-test-'));
  if (talosYml !== undefined) await writeFile(join(root, 'talos.yml'), talosYml);
  return root;
}

describe('loadConfig', () => {
  it("reads the checkout's own talos.yml, even when a fallback is given", async () => {
    const config = await loadConfig(await checkout('name: Own\nprefix: O\n'), HEAD);
    expect(config.name).toBe('Own');
  });

  it('takes the fallback only for a checkout without talos.yml', async () => {
    expect(await loadConfig(await checkout(), HEAD)).toBe(HEAD);
    await expect(loadConfig(await checkout())).rejects.toThrow(ConfigError);
  });

  it('never lets the fallback hide a talos.yml it cannot read', async () => {
    await expect(loadConfig(await checkout('name: [\n'), HEAD)).rejects.toThrow(ConfigError);
  });
});

describe('paths in talos.yml', () => {
  const yml = (lines: readonly string[]): string =>
    ['name: A', 'prefix: A', ...lines, ''].join('\n');

  it('reads every path in one form: no leading ./, no trailing /, no doubled /', () => {
    const config = parseConfig(
      yml([
        'components:',
        '  - { lang: ts, root: ./apps/web/ }',
        '  - { lang: py, root: ./ }',
        'exclude: [./apps/web/dist, apps//web/generated/]',
        'tests: { full: [./tests/e2e] }',
        'mutation: [./apps/web/src/risk/**]',
        'docs: { glossary: ./docs/glossary.md, briefs: docs/requirements/ }',
      ]),
    );
    expect(config.components.map((c) => c.root)).toEqual(['apps/web', '.']);
    expect(config.exclude).toEqual(['apps/web/dist', 'apps/web/generated']);
    expect(config.tests.full).toEqual(['tests/e2e']);
    expect(config.mutation).toEqual(['apps/web/src/risk/**']);
    expect(config.docs).toEqual({ glossary: 'docs/glossary.md', briefs: 'docs/requirements' });
  });

  it('refuses a path outside the repository or written with backslashes', () => {
    for (const root of ['/srv/app', '../app', 'apps\\web', 'apps/../..']) {
      expect(() => parseConfig(yml(['components:', `  - { lang: ts, root: '${root}' }`]))).toThrow(
        ConfigError,
      );
    }
  });
});

describe('supply_chain in talos.yml', () => {
  const yml = (list: 'allow' | 'exceptions', expires: string): string =>
    [
      'name: A',
      'prefix: A',
      'supply_chain:',
      `  ${list}:`,
      `    "six@1.17.0": { reason: needed, expires: '${expires}' }`,
      '',
    ].join('\n');

  it('reads an expiry that is a day of the calendar, a leap day included', () => {
    for (const list of ['allow', 'exceptions'] as const) {
      expect(parseConfig(yml(list, '2028-02-29')).supply_chain[list]).toEqual({
        'six@1.17.0': { reason: 'needed', expires: '2028-02-29' },
      });
    }
  });

  it('refuses an expiry that is not a date or not a day of the calendar', () => {
    for (const list of ['allow', 'exceptions'] as const) {
      for (const expires of ['soon', '2027-13-01', '2027-02-30']) {
        expect(() => parseConfig(yml(list, expires)), `${list} ${expires}`).toThrow(ConfigError);
      }
    }
  });
});

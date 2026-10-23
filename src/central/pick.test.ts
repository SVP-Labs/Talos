import { describe, expect, it } from 'vitest';
import { pickRepositories } from './pick.js';
import { CentralError } from './repos.js';
import { fakeGitHub, propertiesPath, propertyValues } from './test/fake-github.js';

/** Zeta, Secret and Other governed (in id order Secret, Other, Zeta); Ungoverned not. */
const LISTING = propertyValues([
  { id: 30, name: 'SVP-Labs/Zeta', talos: 'stable' },
  { id: 10, name: 'SVP-Labs/Secret', talos: 'canary' },
  { id: 15, name: 'SVP-Labs/Ungoverned' },
  { id: 20, name: 'SVP-Labs/Other', talos: 'evaluate' },
  { id: 25, name: 'SVP-Labs/Paused', talos: 'off' },
]);

function setUp(wanted: { index?: string; channel?: string }, listing = LISTING) {
  const fake = fakeGitHub({ [propertiesPath('SVP-Labs')]: listing });
  const printed: string[] = [];
  const outputs: string[] = [];
  const deps = {
    properties: fake.gh,
    org: 'SVP-Labs',
    ...wanted,
    out: (text: string) => {
      printed.push(text);
    },
    output: (key: string, value: string) => {
      outputs.push(`${key}=${value}`);
      return Promise.resolve();
    },
  };
  return { deps, fake, printed, outputs };
}

describe('pickRepositories', () => {
  it('picks the governed repository at an index, in id order, masking it before handing it on', async () => {
    const { deps, printed, outputs, fake } = setUp({ index: '1' });
    expect(await pickRepositories(deps)).toEqual({ repositories: 1 });
    expect(printed).toEqual(['::add-mask::SVP-Labs/Other\n::add-mask::Other\n']);
    expect(outputs).toEqual(['names=Other']);
    expect(fake.unmatched).toEqual([]);
  });

  it('counts each governed repository once per index, and none past the last', async () => {
    const names: string[] = [];
    for (const index of ['0', '1', '2']) {
      const { deps, outputs } = setUp({ index });
      await pickRepositories(deps);
      names.push(...outputs);
    }
    expect(names).toEqual(['names=Secret', 'names=Other', 'names=Zeta']);
    const past = setUp({ index: '3' });
    expect(await pickRepositories(past.deps)).toEqual({ repositories: 0 });
    expect(past.printed).toEqual([]);
    expect(past.outputs).toEqual(['names=']);
  });

  it('masks every repository on a channel, then hands their bare names on, comma-separated', async () => {
    const canaries = propertyValues([
      { id: 2, name: 'SVP-Labs/Beta', talos: 'canary' },
      { id: 1, name: 'SVP-Labs/Alpha', talos: 'canary' },
      { id: 3, name: 'SVP-Labs/Gamma', talos: 'stable' },
    ]);
    const { deps, printed, outputs } = setUp({ channel: 'canary' }, canaries);
    expect(await pickRepositories(deps)).toEqual({ repositories: 2 });
    expect(printed).toEqual([
      [
        '::add-mask::SVP-Labs/Alpha',
        '::add-mask::SVP-Labs/Beta',
        '::add-mask::Alpha',
        '::add-mask::Beta',
        '',
      ].join('\n'),
    ]);
    expect(outputs).toEqual(['names=Alpha,Beta']);
    const none = setUp({ channel: 'canary' }, propertyValues([]));
    expect(await pickRepositories(none.deps)).toEqual({ repositories: 0 });
    expect(none.outputs).toEqual(['names=']);
  });

  it('refuses a missing, empty or malformed index, or an unknown channel, before reading anything', async () => {
    for (const wanted of [
      {},
      { index: '' },
      { index: 'x' },
      { index: '-1' },
      { channel: 'beta' },
    ]) {
      const { deps, fake, outputs } = setUp(wanted);
      await expect(pickRepositories(deps), JSON.stringify(wanted)).rejects.toThrow(CentralError);
      expect(fake.calls).toEqual([]);
      expect(outputs).toEqual([]);
    }
  });

  it('hands on and prints nothing when a name could split a workflow command or an output', async () => {
    for (const name of ['SVP-Labs/a\n::stop-commands::x', 'SVP-Labs/a,b', 'SVP-Labs/a/b', 'x']) {
      const { deps, printed, outputs } = setUp(
        { index: '0' },
        propertyValues([{ id: 1, name, talos: 'stable' }]),
      );
      await expect(pickRepositories(deps), name).rejects.toThrow(CentralError);
      expect(printed).toEqual([]);
      expect(outputs).toEqual([]);
    }
  });

  it('fails without printing a name when the listing cannot be read', async () => {
    const { deps, printed, outputs } = setUp({ index: '0' });
    const broken = { ...deps, properties: fakeGitHub().gh };
    await expect(pickRepositories(broken)).rejects.toThrow();
    expect(printed).toEqual([]);
    expect(outputs).toEqual([]);
  });
});

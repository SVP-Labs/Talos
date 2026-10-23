import { describe, expect, it, vi } from 'vitest';
import {
  checkNew,
  createRepository,
  nameProblem,
  prefixesInUse,
  prefixHolder,
  prefixIn,
  prefixProblem,
  seedConfig,
  whenReady,
} from './create.js';
import { GovernRefusal } from './plan.js';
import { fakeApi, json, NOT_FOUND, route } from './test/fake-api.js';
import { parseConfig } from '../config/load.js';
import { GitHubError } from '../github/api.js';

function file(text: string) {
  return json({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(text).toString('base64'),
    sha: 's',
  });
}

function org() {
  return fakeApi([
    route(
      'GET',
      /^orgs\/SVP-Labs\/repos$/,
      json([
        { id: 1, full_name: 'SVP-Labs/Thea', default_branch: 'main' },
        { id: 2, full_name: 'SVP-Labs/LoreLock', default_branch: 'main' },
        { id: 3, full_name: 'SVP-Labs/Old', default_branch: 'main', archived: true },
        { id: 4, full_name: 'SVP-Labs/Blank', default_branch: 'main' },
      ]),
    ),
    route('GET', /^repos\/SVP-Labs\/Thea\/contents\/talos\.yml$/, file('name: Thea\nprefix: T\n')),
    route(
      'GET',
      /^repos\/SVP-Labs\/LoreLock\/contents\/project\.yml$/,
      file('name: LoreLock\nprefix: "L"\nscaffold: {}\n'),
    ),
    route('GET', /^repos\/SVP-Labs\/Old\/contents\/talos\.yml$/, file('prefix: O\n')),
    route('GET', /^repos\/SVP-Labs\/Thea$/, json({ id: 1 })),
    route('POST', /^orgs\/SVP-Labs\/repos$/, json({ id: 9, full_name: 'SVP-Labs/New' }, 201)),
  ]);
}

describe('names and prefixes', () => {
  it('takes repository names GitHub takes', () => {
    expect(nameProblem('Notebook')).toBeUndefined();
    expect(nameProblem('coe5.tool_box-2')).toBeUndefined();
    for (const bad of ['', '.', '..', 'a b', 'x.git', 'a/b']) {
      expect(nameProblem(bad)).toBeDefined();
    }
  });

  it('takes prefixes talos.yml takes', () => {
    expect(prefixProblem('TL')).toBeUndefined();
    expect(prefixProblem('tl')).toBeDefined();
    expect(prefixProblem('ABCDEFG')).toBeDefined();
  });

  it('reads a prefix from talos.yml or project.yml', () => {
    expect(prefixIn('name: X\nprefix: X\n')).toBe('X');
    expect(prefixIn('prefix: ""\n')).toBeUndefined();
    expect(prefixIn(': : :')).toBeUndefined();
    expect(prefixIn(undefined)).toBeUndefined();
  });

  it('finds the holder of a prefix without regard to case', () => {
    const uses = [{ repo: 'SVP-Labs/Thea', prefix: 'T' }];
    expect(prefixHolder(uses, 't')).toBe('SVP-Labs/Thea');
    expect(prefixHolder(uses, 'TL')).toBeUndefined();
  });

  it('writes a seed talos.yml that Talos reads', () => {
    expect(parseConfig(seedConfig('Notebook', 'S'))).toMatchObject({
      name: 'Notebook',
      prefix: 'S',
    });
    expect(seedConfig('CoE5: Toolbox', 'CT')).toBe('name: "CoE5: Toolbox"\nprefix: CT\n');
    expect(parseConfig(seedConfig('CoE5: Toolbox', 'CT')).name).toBe('CoE5: Toolbox');
  });
});

describe('the organisation', () => {
  it("lists every live repository's prefix", async () => {
    expect(await prefixesInUse(org().client(), 'SVP-Labs')).toEqual([
      { repo: 'SVP-Labs/Thea', prefix: 'T' },
      { repo: 'SVP-Labs/LoreLock', prefix: 'L' },
    ]);
  });

  it('refuses a taken name or prefix', async () => {
    const gh = org().client();
    await expect(checkNew(gh, 'SVP-Labs', 'Thea', 'X')).rejects.toThrow(/exists already/);
    await expect(checkNew(gh, 'SVP-Labs', 'New', 'l')).rejects.toThrow(GovernRefusal);
    await expect(checkNew(gh, 'SVP-Labs', 'New', 'N')).resolves.toBeUndefined();
  });

  it('creates a private repository with a first commit', async () => {
    const api = org();
    await createRepository(api.client(), 'SVP-Labs', 'New', 'private');
    expect(api.calls.at(-1)?.body).toEqual({ name: 'New', private: true, auto_init: true });
  });
});

describe('whenReady', () => {
  it('retries while a new repository settles, then gives up', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let calls = 0;
    const settles = () => {
      calls += 1;
      return calls < 3 ? Promise.reject(new GitHubError('x', 409)) : Promise.resolve('ok');
    };
    await expect(whenReady(settles, sleep)).resolves.toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(2);
    await expect(
      whenReady(() => Promise.reject(new GitHubError('x', 404)), sleep, 2),
    ).rejects.toThrow('x');
    await expect(
      whenReady(() => Promise.reject(new GitHubError('no', 403)), sleep),
    ).rejects.toThrow('no');
    expect(NOT_FOUND.status).toBe(404);
  });
});

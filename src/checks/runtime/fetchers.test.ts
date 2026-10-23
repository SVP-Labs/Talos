import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cachedFetcher,
  defaultFetcher,
  FEEDS_VARIABLE,
  type FeedRequest,
  fetcherFor,
  fixtureFetcher,
  httpFetcher,
  networkFetcher,
} from './fetchers.js';
import { EngineError } from '../../core/check.js';

const REQUEST: FeedRequest = { name: 'endoflife-php', url: 'https://endoflife.example/php' };

describe('httpFetcher', () => {
  it('returns the body of a good answer, asking for JSON with a timeout', async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    );
    await expect(httpFetcher(fetch)(REQUEST)).resolves.toBe('{"ok":true}');
    const init = fetch.mock.calls[0]?.[1];
    expect(fetch.mock.calls[0]?.[0]).toBe(REQUEST.url);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({ accept: 'application/json' });
  });

  it('turns an HTTP error, an unreachable host or a cut-off body into an engine error', async () => {
    const unavailable = httpFetcher(() => Promise.resolve(new Response('', { status: 503 })));
    await expect(unavailable(REQUEST)).rejects.toThrow('the endoflife-php feed answered HTTP 503');
    const unreachable = httpFetcher(() => Promise.reject(new TypeError('fetch failed')));
    await expect(unreachable(REQUEST)).rejects.toThrow(
      'the endoflife-php feed could not be reached',
    );
    const broken = new Response('{}', { status: 200 });
    vi.spyOn(broken, 'text').mockRejectedValue(new TypeError('terminated'));
    const cutOff = httpFetcher(() => Promise.resolve(broken));
    await expect(cutOff(REQUEST)).rejects.toThrow(EngineError);
  });
});

describe('fixtureFetcher', () => {
  it('reads <name>.json from the directory, and says which one is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talos-feeds-'));
    await writeFile(join(dir, 'endoflife-php.json'), '[]');
    await expect(fixtureFetcher(dir)(REQUEST)).resolves.toBe('[]');
    await expect(fixtureFetcher(dir)({ name: 'node-index', url: 'x' })).rejects.toThrow(
      `${FEEDS_VARIABLE} has no recorded node-index.json`,
    );
  });
});

describe('cachedFetcher', () => {
  it('shares one fetch per feed until it expires, and forgets a failure', async () => {
    let clock = 0;
    let calls = 0;
    let fail = true;
    const inner = (): Promise<string> => {
      calls += 1;
      return fail ? Promise.reject(new EngineError('down')) : Promise.resolve(`body ${calls}`);
    };
    const cached = cachedFetcher(inner, 100, () => clock);
    await expect(cached(REQUEST)).rejects.toThrow('down');
    fail = false;
    await expect(cached(REQUEST)).resolves.toBe('body 2');
    clock = 99;
    await expect(cached(REQUEST)).resolves.toBe('body 2');
    clock = 100;
    await expect(cached(REQUEST)).resolves.toBe('body 3');
    expect(calls).toBe(3);
  });
});

describe('fetcherFor', () => {
  it('uses the recorded feeds when the variable names a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talos-feeds-'));
    await writeFile(join(dir, 'endoflife-php.json'), '{"recorded":1}');
    await expect(fetcherFor({ [FEEDS_VARIABLE]: dir })(REQUEST)).resolves.toBe('{"recorded":1}');
    expect(fetcherFor({ [FEEDS_VARIABLE]: '' })).toBe(networkFetcher);
    expect(fetcherFor({})).toBe(networkFetcher);
  });

  it('keeps one cached fetcher per process until the variable changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talos-feeds-'));
    await writeFile(join(dir, 'endoflife-php.json'), '"from disk"');
    const before = process.env[FEEDS_VARIABLE];
    try {
      process.env[FEEDS_VARIABLE] = dir;
      const first = defaultFetcher();
      expect(defaultFetcher()).toBe(first);
      await expect(first(REQUEST)).resolves.toBe('"from disk"');
      process.env[FEEDS_VARIABLE] = join(dir, 'other');
      expect(defaultFetcher()).not.toBe(first);
    } finally {
      if (before === undefined) delete process.env.TALOS_RUNTIME_FEEDS;
      else process.env[FEEDS_VARIABLE] = before;
    }
  });
});

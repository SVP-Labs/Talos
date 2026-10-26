import { describe, expect, it } from 'vitest';
import type { Declaration } from './declaration.js';
import {
  endOfLifeRequest,
  loadFeeds,
  NODE_INDEX,
  parseEndOfLife,
  parseNodeIndex,
  parsePhpReleases,
  phpReleasesRequest,
} from './feeds.js';
import {
  ENDOFLIFE_PHP,
  ENDOFLIFE_RUST,
  NODE_INDEX_EXCERPT,
  PHP_RELEASES_84,
  recordedFetcher,
} from './test/recorded.js';
import { EngineError } from '../../core/check.js';

describe('endoflife.date', () => {
  it("reads each cycle's newest release, end of life and end of active support", () => {
    const cycles = parseEndOfLife(JSON.stringify(ENDOFLIFE_PHP));
    expect(cycles.find((c) => c.name === '8.4')).toEqual({
      name: '8.4',
      latest: '8.4.27',
      latestDate: '2026-10-21',
      eol: '2028-12-31',
      isEol: false,
      activeUntil: '2026-12-31',
    });
    expect(cycles.find((c) => c.name === '8.1')).toMatchObject({ isEol: true, eol: '2025-12-31' });
  });

  it('leaves out what a product has no date or release for', () => {
    const cycles = parseEndOfLife(JSON.stringify(ENDOFLIFE_RUST));
    expect(cycles[0]).toEqual({
      name: '1.99',
      latest: '1.99.1',
      latestDate: '2026-10-15',
      isEol: false,
    });
    const odd = { result: { releases: [{ name: '1', eolFrom: true, latest: null }] } };
    expect(parseEndOfLife(JSON.stringify(odd))).toEqual([{ name: '1', isEol: false }]);
  });

  it('refuses a body that is not JSON or not a product', () => {
    expect(() => parseEndOfLife('<html>')).toThrow(EngineError);
    expect(() => parseEndOfLife('{"result": {}}')).toThrow(/unexpected shape/);
  });
});

describe('php.net', () => {
  it('keeps the releases tagged security', () => {
    expect(parsePhpReleases(JSON.stringify(PHP_RELEASES_84))).toEqual(['8.4.27', '8.4.26']);
  });

  it('has none for a cycle it does not know', () => {
    expect(parsePhpReleases('{"error":"Unknown version"}')).toEqual([]);
    expect(() => parsePhpReleases('[]')).toThrow(EngineError);
  });
});

describe('nodejs.org', () => {
  it('keeps the releases marked security, without their v', () => {
    expect(parseNodeIndex(JSON.stringify(NODE_INDEX_EXCERPT))).toEqual([
      '26.12.1',
      '24.22.1',
      '22.23.4',
    ]);
    expect(() => parseNodeIndex('{}')).toThrow(EngineError);
  });
});

describe('requests', () => {
  it('name each feed for its recorded copy', () => {
    expect(endOfLifeRequest('nodejs')).toEqual({
      name: 'endoflife-nodejs',
      url: 'https://endoflife.date/api/v1/products/nodejs',
    });
    expect(phpReleasesRequest('8.4')).toEqual({
      name: 'php-releases-8.4',
      url: 'https://www.php.net/releases/index.php?json&version=8.4&max=1000',
    });
    expect(NODE_INDEX.url).toBe('https://nodejs.org/dist/index.json');
  });
});

function declared(
  runtime: Declaration['runtime'],
  version: string,
  exactness: Declaration['exactness'],
): Declaration {
  return { runtime, file: 'f', line: 1, written: version, version, exactness };
}

describe('loadFeeds', () => {
  it("fetches each runtime's cycles once, and security flags only for exact pins", async () => {
    const fetcher = recordedFetcher();
    const feeds = await loadFeeds(
      [
        declared('php', '8.4.26', 'exact'),
        declared('php', '8.4.20', 'exact'),
        declared('php', '8.1.0', 'minimum'),
        declared('node', '22', 'floating'),
        declared('python', '3.13.1', 'exact'),
      ],
      fetcher,
    );
    expect(new Set(fetcher.requests.map((r) => r.name))).toEqual(
      new Set(['endoflife-nodejs', 'endoflife-php', 'endoflife-python', 'php-releases-8.4']),
    );
    expect(fetcher.requests).toHaveLength(4);
    expect([...(feeds.get('php')?.security ?? [])]).toEqual(['8.4.27', '8.4.26']);
    expect(feeds.get('node')?.security).toBeUndefined();
    expect(feeds.get('python')?.security).toBeUndefined();
  });

  it("reads nodejs.org's index for an exact Node.js pin", async () => {
    const fetcher = recordedFetcher();
    const feeds = await loadFeeds([declared('node', '22.12.0', 'exact')], fetcher);
    expect(fetcher.requests.map((r) => r.name)).toEqual(['endoflife-nodejs', 'node-index']);
    expect(feeds.get('node')?.security?.has('22.23.4')).toBe(true);
  });

  it('asks no security feed for a pin outside every known cycle', async () => {
    const fetcher = recordedFetcher();
    await loadFeeds([declared('php', '9.0.1', 'exact')], fetcher);
    expect(fetcher.requests.map((r) => r.name)).toEqual(['endoflife-php']);
  });
});

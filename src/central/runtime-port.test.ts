import { describe, expect, it } from 'vitest';
import { runtimeAssessor } from './runtime-port.js';
import { recordedFetcher, TODAY } from '../checks/runtime/test/recorded.js';

const assess = runtimeAssessor({ fetcher: recordedFetcher(), today: () => TODAY });

describe('runtimeAssessor', () => {
  it("finds what the gate's runtime check finds, as alerts", async () => {
    const files = new Map([
      ['Dockerfile', 'FROM php:8.4.26-fpm\n'],
      ['api/Containerfile', 'FROM php:8.4.27-cli\n'],
      ['web/.nvmrc', '22.23.3\n'],
      ['talos.yml', 'name: App\nprefix: AP\nexclude: [vendor]\n'],
      ['vendor/x/Dockerfile', 'FROM php:8.3.35\n'],
    ]);
    expect(await assess(files)).toEqual({
      alerts: [
        { runtime: 'php', version: '8.4.26', fixed: '8.4.27', file: 'Dockerfile' },
        { runtime: 'node', version: '22.23.3', fixed: '22.23.4', file: 'web/.nvmrc' },
      ],
      errors: 0,
    });
  });

  it("honours talos.yml's unexpired exceptions, and a plain config when it is invalid", async () => {
    const excepted = [
      'name: App',
      'prefix: AP',
      'supply_chain:',
      '  exceptions:',
      '    "php 8.4.26": { reason: "rebuilt with the patch", expires: "2026-10-30" }',
      '',
    ].join('\n');
    const dockerfile = 'FROM php:8.4.26-fpm\n';
    expect(
      await assess(
        new Map([
          ['Dockerfile', dockerfile],
          ['talos.yml', excepted],
        ]),
      ),
    ).toEqual({
      alerts: [],
      errors: 0,
    });
    const invalid = await assess(
      new Map([
        ['Dockerfile', dockerfile],
        ['talos.yml', 'name: [\n'],
      ]),
    );
    expect(invalid.alerts).toHaveLength(1);
  });

  it('counts a feed that cannot be read as one error, never as a pass', async () => {
    const failing = runtimeAssessor({
      fetcher: () => Promise.reject(new Error('Dockerfile: the feed is down')),
      today: () => TODAY,
    });
    expect(await failing(new Map([['Dockerfile', 'FROM php:8.4.26-fpm\n']]))).toEqual({
      alerts: [],
      errors: 1,
    });
  });

  it('asks no feed for a repository without declarations', async () => {
    const fetcher = recordedFetcher();
    const quiet = runtimeAssessor({ fetcher, today: () => TODAY });
    expect(await quiet(new Map([['talos.yml', 'name: A\nprefix: A\n']]))).toEqual({
      alerts: [],
      errors: 0,
    });
    expect(fetcher.requests).toEqual([]);
  });

  it('uses the live feeds by default', () => {
    expect(typeof runtimeAssessor()).toBe('function');
  });
});

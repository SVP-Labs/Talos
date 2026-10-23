import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireNewestPhp, staleness } from './runtime.js';
import type { RuntimeFeed } from '../../checks/runtime/feeds.js';
import { fixtureFetcher } from '../../checks/runtime/fetchers.js';
import { EngineError } from '../../core/check.js';
import { type Exec, ExecError } from '../../exec/exec.js';

const FEED: RuntimeFeed = {
  cycles: [
    { name: '8.5', latest: '8.5.12', eol: '2029-12-31', isEol: false },
    { name: '8.4', latest: '8.4.27', eol: '2028-12-31', isEol: false },
    { name: '8.1', latest: '8.1.34', eol: '2025-12-31', isEol: false },
    { name: '8.0', latest: '8.0.30', isEol: true },
  ],
  security: new Set(['8.5.11', '8.5.12', '8.4.26']),
};

const TODAY = '2026-10-23';
const RECORDED = {
  fetcher: fixtureFetcher(join('test-projects', 'runtime', 'feeds')),
  today: TODAY,
};

function php(stdout: string, code = 0): Exec {
  return () => Promise.resolve({ code, stdout, stderr: code === 0 ? '' : 'broken' });
}

describe('staleness', () => {
  it('passes the newest release of each cycle', () => {
    expect(staleness('8.5.12', FEED, TODAY)).toBeUndefined();
    expect(staleness('8.4.27', FEED, TODAY)).toBeUndefined();
  });

  it('names the security release an older PHP misses', () => {
    expect(staleness('8.5.11', FEED, TODAY)).toBe(
      'PHP 8.5.11 is not the newest 8.5 release: 8.5.12 is, a security release',
    );
  });

  it('refuses an older release even when the newer one fixes no security issue', () => {
    expect(staleness('8.4.26', FEED, TODAY)).toBe(
      'PHP 8.4.26 is not the newest 8.4 release: 8.4.27 is',
    );
  });

  it('refuses a cycle past its end of life, by flag or by date', () => {
    expect(staleness('8.0.30', FEED, TODAY)).toMatch(/^PHP 8\.0 is past its end of life/);
    expect(staleness('8.1.34', FEED, TODAY)).toMatch(/^PHP 8\.1 is past its end of life/);
  });

  it('refuses a release no cycle holds', () => {
    expect(staleness('9.0.0', FEED, TODAY)).toBe('PHP 9.0.0 is no release endoflife.date knows');
  });
});

describe('requireNewestPhp', () => {
  it('lets the newest PHP run, judged by the recorded feeds', async () => {
    await expect(requireNewestPhp(php('8.5.12\n'), '.', RECORDED)).resolves.toBeUndefined();
  });

  it('stops a PHP from before the newest security release', async () => {
    await expect(requireNewestPhp(php('8.4.26'), '.', RECORDED)).rejects.toThrow(
      'PHP 8.4.26 is not the newest 8.4 release: 8.4.27 is, a security release; update the PHP on PATH',
    );
  });

  it('is an engine error when php is missing or says something odd', async () => {
    const missing: Exec = () => Promise.reject(new ExecError('php: not found'));
    await expect(requireNewestPhp(missing, '.', RECORDED)).rejects.toThrow(
      new EngineError('php is needed on PATH: php: not found'),
    );
    await expect(requireNewestPhp(php('', 255), '.', RECORDED)).rejects.toThrow(
      'php is needed on PATH: broken',
    );
    await expect(requireNewestPhp(php('8.5'), '.', RECORDED)).rejects.toThrow(
      'php reported no release: "8.5"',
    );
  });

  it('passes on any other failure as it is', async () => {
    const broken: Exec = () => Promise.reject(new TypeError('bug'));
    await expect(requireNewestPhp(broken, '.', RECORDED)).rejects.toThrow(TypeError);
  });
});

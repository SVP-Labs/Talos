import { describe, expect, it } from 'vitest';
import { assessRuntimes } from './assess.js';
import type { Declaration } from './declaration.js';
import { declaredRuntimes } from './declarations.js';
import { type Feeds, loadFeeds } from './feeds.js';
import { recordedFetcher, TODAY } from './test/recorded.js';
import { EngineError } from '../../core/check.js';

async function judge(files: Record<string, string>, today = TODAY) {
  const declarations = declaredRuntimes(new Map(Object.entries(files)));
  const feeds = await loadFeeds(declarations, recordedFetcher());
  return assessRuntimes(declarations, feeds, today);
}

describe('php2shell', () => {
  // PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35 are the first of their cycles to fix CVE-2026-109618
  // and CVE-2026-109619.
  it('makes php:8.4.26-fpm a security finding that fails every PR', async () => {
    expect(await judge({ 'docker/Dockerfile': 'FROM php:8.4.26-fpm\n' })).toEqual([
      {
        rule: 'runtime/security',
        message:
          'PHP 8.4.26 (php:8.4.26-fpm) is behind a security release of its cycle; move to 8.4.27 or later.',
        location: { file: 'docker/Dockerfile', line: 1 },
        key: 'php 8.4.26',
        policy: 'always',
        docs: 'https://endoflife.date/php',
      },
    ]);
  });

  it('passes the fixed releases', async () => {
    const dockerfile = 'FROM php:8.4.27-fpm AS app\nFROM php:8.5.12-cli\n';
    expect(await judge({ Dockerfile: dockerfile })).toEqual([]);
  });

  it("never makes composer.json's platform PHP a security finding: it is a minimum", async () => {
    const composer = '{"config": {"platform": {"php": "8.4.26"}}}';
    expect(await judge({ 'composer.json': composer })).toEqual([]);
  });
});

describe('security releases', () => {
  it("reads Node.js's flags across the whole major", async () => {
    const [finding] = await judge({ '.nvmrc': '22.12.0\n' });
    expect(finding).toMatchObject({
      rule: 'runtime/security',
      key: 'node 22.12.0',
      policy: 'always',
    });
    expect(finding?.message).toBe(
      'Node.js 22.12.0 is behind a security release of its cycle; move to 22.23.4 or later.',
    );
    expect(await judge({ '.node-version': '22.23.4' })).toEqual([]);
  });

  it('takes a CPython release made after active support ended as a security release', async () => {
    const [finding] = await judge({ '.python-version': '3.13.1\n' });
    expect(finding).toMatchObject({ rule: 'runtime/security', key: 'python 3.13.1' });
    expect(finding?.message).toContain('move to 3.13.17 or later');
    expect(await judge({ '.python-version': '3.14.1\n' })).toEqual([]);
  });

  it("has no security source for Rust or Go: only their cycles' ends of life count", async () => {
    expect(await judge({ 'rust-toolchain.toml': '[toolchain]\nchannel = "1.99.0"\n' })).toEqual([]);
    expect(await judge({ 'go.mod': 'module m\ntoolchain go1.27.0\n' })).toEqual([]);
  });

  it('suggests the newest release when it is newer than the security fix', () => {
    const feeds: Feeds = new Map([
      [
        'php',
        {
          cycles: [{ name: '8.4', latest: '8.4.28', isEol: false }],
          security: new Set(['8.4.27']),
        },
      ],
    ]);
    const declaration: Declaration = {
      runtime: 'php',
      file: 'Dockerfile',
      line: 3,
      endLine: 4,
      written: 'php:8.4.26',
      version: '8.4.26',
      exactness: 'exact',
    };
    const [finding] = assessRuntimes([declaration], feeds, TODAY);
    expect(finding?.message).toContain(
      "move to 8.4.28, the cycle's newest (8.4.27 is its newest security release)",
    );
    expect(finding?.location).toEqual({ file: 'Dockerfile', line: 3, endLine: 4 });
  });
});

describe('end of life', () => {
  it('reports a cycle past its end of life, and suggests the newest supported one', async () => {
    expect(await judge({ Dockerfile: 'FROM php:8.1.34-fpm\n' })).toEqual([
      {
        rule: 'runtime/eol',
        message:
          'PHP 8.1 (php:8.1.34-fpm) reached its end of life on 2025-12-31 and gets no more security releases; move to a supported cycle such as 8.5.',
        location: { file: 'Dockerfile', line: 1 },
        docs: 'https://endoflife.date/php',
      },
    ]);
  });

  it("counts the end-of-life date itself, before the feed's flag catches up", async () => {
    const [finding] = await judge({ '.python-version': '3.14.9' }, '2030-10-31');
    expect(finding?.rule).toBe('runtime/eol');
    expect(await judge({ '.python-version': '3.14.9' }, '2030-10-30')).toEqual([]);
  });

  it("reports an end-of-life minimum in composer.json's terms", async () => {
    const [finding] = await judge({
      'composer.json': '{"config": {"platform": {"php": "8.1.0"}}}',
    });
    expect(finding).toMatchObject({
      rule: 'runtime/eol',
      location: { file: 'composer.json', line: 1 },
    });
    expect(finding?.message).toBe(
      'composer.json resolves dependencies for PHP 8.1, which reached its end of life on 2025-12-31; raise config.platform.php to a supported cycle such as 8.5.',
    );
  });

  it('reports a floating pin on a dead cycle as both unpinned and past its end of life', async () => {
    const rules = (await judge({ '.nvmrc': '20\n' })).map((f) => f.rule);
    expect(rules).toEqual(['runtime/eol', 'runtime/unpinned']);
  });

  it('says so when the feed gives no date', () => {
    const feeds: Feeds = new Map([['rust', { cycles: [{ name: '1.50', isEol: true }] }]]);
    const declaration: Declaration = {
      runtime: 'rust',
      file: 'rust-toolchain',
      line: 1,
      written: '1.50.0',
      version: '1.50.0',
      exactness: 'exact',
    };
    expect(assessRuntimes([declaration], feeds, TODAY)[0]?.message).toBe(
      'Rust 1.50 is past its end of life and gets no more security releases; move to a supported cycle.',
    );
  });
});

describe('unpinned', () => {
  it("reports a floating tag, with its own cycle's newest release as the example", async () => {
    expect(await judge({ Dockerfile: 'FROM node:24-trixie-slim\n' })).toEqual([
      {
        rule: 'runtime/unpinned',
        message:
          "node:24-trixie-slim in Dockerfile pins no exact Node.js release, so it can't be checked for security releases; pin an exact release, such as 24.22.1.",
        location: { file: 'Dockerfile', line: 1 },
        docs: 'https://endoflife.date/nodejs',
      },
    ]);
  });

  it('suggests the newest supported release when the pin names no live cycle', async () => {
    const [alias] = await judge({ '.nvmrc': 'lts/*' });
    expect(alias?.message).toContain('pin an exact release, such as 26.12.1.');
    const [, dead] = await judge({ '.nvmrc': '20' });
    expect(dead?.message).toContain('pin an exact release, such as 26.12.1.');
  });

  it('clips a long declaration and still reports an image with no version at all', async () => {
    const long = `FROM python:${'x'.repeat(100)}\n`;
    const [finding] = await judge({ Dockerfile: long });
    expect(finding?.message).toMatch(/^python:x{70,}… in Dockerfile pins no exact Python release/);
  });

  it('keeps a pin it cannot place in any cycle quiet', async () => {
    expect(await judge({ Dockerfile: 'FROM php:9.0.1\n' })).toEqual([]);
  });
});

describe('feeds', () => {
  it('is an engine error to judge a runtime whose feed was not loaded', () => {
    const declaration: Declaration = {
      runtime: 'ruby',
      file: 'Dockerfile',
      line: 1,
      written: 'ruby:3.3.6',
      version: '3.3.6',
      exactness: 'exact',
    };
    expect(() => assessRuntimes([declaration], new Map(), TODAY)).toThrow(EngineError);
    const noFlags: Feeds = new Map([['php', { cycles: [{ name: '3.3', isEol: false }] }]]);
    const php: Declaration = { ...declaration, runtime: 'php' };
    expect(() => assessRuntimes([php], noFlags, TODAY)).toThrow(
      'no security feed was loaded for php',
    );
  });
});

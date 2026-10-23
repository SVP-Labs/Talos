import { describe, expect, it } from 'vitest';
import { excepted, runtimeFindings, runtimesCheck } from './check.js';
import { runtimePack } from './index.js';
import { recordedFetcher, TODAY } from './test/recorded.js';
import { parseConfig } from '../../config/load.js';
import type { Finding } from '../../core/finding.js';
import { runChecks } from '../../engine/run.js';
import { tempRepo, testEngine, testPlan } from '../../testing/engine.js';

const check = runtimesCheck({ fetcher: () => recordedFetcher(), today: () => TODAY });
const pack = { name: 'runtime', checks: [check] };

async function run(files: Record<string, string>, config = 'name: App\nprefix: AP\n') {
  const root = await tempRepo(files);
  const result = await runChecks(
    testEngine([pack]),
    testPlan(root, Object.keys(files), parseConfig(config)),
  );
  const [outcome] = result.outcomes;
  return outcome;
}

describe('runtime/runtimes', () => {
  it('locates each finding on the declaring line, the security one by its key', async () => {
    const outcome = await run({
      Dockerfile: 'ARG PHP=8.4.26\nFROM php:${PHP}-fpm\nFROM node:24-slim\n',
      'web/.python-version': '3.14.9\n',
    });
    expect(outcome?.status).toBe('findings');
    expect(
      outcome?.findings.map((f) => [f.rule, f.policy, f.location?.file, f.location?.line]),
    ).toEqual([
      ['runtime/security', 'always', 'Dockerfile', 1],
      ['runtime/unpinned', 'standard', 'Dockerfile', 3],
    ]);
  });

  it('skips a repository that declares no runtime', async () => {
    const outcome = await run({ 'src/app.ts': 'export {};\n' });
    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'no Dockerfile, runtime version file or tools.lock declares a runtime',
    });
  });

  it('honours an unexpired exception for a security finding, and no other', async () => {
    const config = [
      'name: App',
      'prefix: AP',
      'supply_chain:',
      '  exceptions:',
      '    "PHP  8.4.26": { reason: "rebuilt with the patch", expires: "2026-10-30" }',
      '    "node 22.12.0": { reason: "expired", expires: "2026-10-01" }',
      '',
    ].join('\n');
    const outcome = await run(
      { Dockerfile: 'FROM php:8.4.26-fpm\n', '.nvmrc': '22.12.0\n' },
      config,
    );
    expect(outcome?.findings.map((f) => f.key)).toEqual(['node 22.12.0']);
  });

  it('is an engine error when a feed cannot be had', async () => {
    const offline = runtimesCheck({
      fetcher: () => () => Promise.reject(new Error('offline')),
      today: () => TODAY,
    });
    const root = await tempRepo({ '.nvmrc': '24.22.1\n' });
    const result = await runChecks(
      testEngine([{ name: 'runtime', checks: [offline] }]),
      testPlan(root, ['.nvmrc']),
    );
    expect(result.outcomes[0]).toMatchObject({ status: 'error', reason: 'offline' });
  });

  it("judges on today's date by default, and fails on a declaring file it can't read", async () => {
    const today = runtimesCheck({ fetcher: () => recordedFetcher() });
    const root = await tempRepo({ Dockerfile: 'FROM php:8.4.26-fpm\n' });
    const engine = testEngine([{ name: 'runtime', checks: [today] }]);
    const found = await runChecks(engine, testPlan(root, ['Dockerfile']));
    expect(found.outcomes[0]?.findings.map((f) => f.rule)).toContain('runtime/security');
    const missing = await runChecks(engine, testPlan(root, ['Dockerfile', 'api/.nvmrc']));
    expect(missing.outcomes[0]).toMatchObject({
      status: 'error',
      reason: 'api/.nvmrc could not be read',
    });
  });

  it('ships in the runtime pack as a repository-wide head check', () => {
    expect(runtimePack.checks.map((c) => [c.id, c.tier, c.scope])).toEqual([
      ['runtime/runtimes', 'head', 'repo'],
    ]);
  });
});

describe('runtimeFindings', () => {
  it('judges files read anywhere, such as through the API, without a checkout', async () => {
    const files = new Map([
      ['services/api/Dockerfile', 'FROM php:8.3.35-cli\n'],
      ['tools.lock', '{"tools": {"python": {"version": "3.13.17", "runtime": true}}}'],
    ]);
    const findings = await runtimeFindings(files, { fetcher: recordedFetcher(), today: TODAY });
    expect(findings.map((f) => [f.rule, f.key, f.location?.file])).toEqual([
      ['runtime/security', 'php 8.3.35', 'services/api/Dockerfile'],
    ]);
  });

  it('fetches nothing when nothing is declared', async () => {
    const fetcher = recordedFetcher();
    expect(await runtimeFindings(new Map([['README.md', '']]), { fetcher, today: TODAY })).toEqual(
      [],
    );
    expect(fetcher.requests).toEqual([]);
  });
});

describe('excepted', () => {
  it('keeps findings without a key and those of other rules', () => {
    const findings: Finding[] = [
      { rule: 'runtime/security', message: 'm' },
      { rule: 'runtime/eol', message: 'm', key: 'php 8.4.26' },
    ];
    const exceptions = { 'php 8.4.26': { reason: 'r', expires: TODAY } };
    expect(excepted(findings, exceptions, TODAY)).toEqual(findings);
  });
});

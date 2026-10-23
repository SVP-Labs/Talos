import { describe, expect, it } from 'vitest';
import { CENTRAL_SCHEMA, centralWith } from './central.js';
import { type Io, UsageError } from './io.js';
import { nameDigest } from '../central/privacy.js';
import type { RuntimeAssessor } from '../central/runtime-port.js';
import { fakeGitHub, installation } from '../central/test/fake-github.js';

const BASE = 'https://api.example.test';

function io(env: Record<string, string>): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    cwd: '/nowhere',
    env,
    out: (text) => {
      lines.push(text);
    },
    err: (text) => {
      lines.push(`err:${text}`);
    },
    lines,
  };
}

const nothing: RuntimeAssessor = () => Promise.resolve({ alerts: [], errors: 0 });

function lastJson(lines: readonly string[]): Record<string, unknown> {
  return JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
}

describe('talos central', () => {
  it('refuses an unknown job and a missing token as usage errors', async () => {
    const central = centralWith({});
    await expect(central(['deploy'], io({}))).rejects.toThrow(UsageError);
    await expect(central([], io({}))).rejects.toThrow(
      'talos central <channels|sweep|drift|privacy>',
    );
    await expect(central(['sweep'], io({}))).rejects.toThrow('TALOS_REVIEWER_TOKEN is not set');
    await expect(central(['privacy'], io({ GITHUB_TOKEN: 'w' }))).rejects.toThrow(
      'TALOS_REVIEWER_TOKEN or TALOS_RELEASE_TOKEN is required',
    );
  });

  it('prints one line of counts for a sweep', async () => {
    const fake = fakeGitHub({
      'GET installation/repositories': installation([{ id: 1, name: 'SVP-Labs/Secret' }]),
    });
    const terminal = io({ TALOS_REVIEWER_TOKEN: 't' });
    const code = await centralWith({ baseUrl: BASE, fetch: fake.fetch, assess: nothing })(
      ['sweep', '--json'],
      terminal,
    );
    expect(code).toBe(0);
    expect(terminal.lines).toEqual([
      `${JSON.stringify({ schema: CENTRAL_SCHEMA, job: 'sweep', ok: true, governed: 0, files: 0, alerts: 0, filed: 0, open: 0, errors: 0 })}\n`,
    ]);
  });

  it('replaces any failure with one generic line that names no repository', async () => {
    const fake = fakeGitHub({
      'GET installation/repositories': { status: 500, body: { message: 'SVP-Labs/Secret broke' } },
    });
    const terminal = io({ TALOS_REVIEWER_TOKEN: 't' });
    const code = await centralWith({ baseUrl: BASE, fetch: fake.fetch, assess: nothing })(
      ['sweep'],
      terminal,
    );
    expect(code).toBe(1);
    expect(terminal.lines).toEqual([
      `${JSON.stringify({ schema: CENTRAL_SCHEMA, job: 'sweep', ok: false, error: 'the runtime sweep could not finish' })}\n`,
    ]);
  });

  it('refuses the urgent promotion for anyone but the owner, before any API call', async () => {
    const fake = fakeGitHub();
    const terminal = io({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_ACTOR: 'thea-svp[bot]',
      GITHUB_TOKEN: 'w',
      TALOS_RELEASE_TOKEN: 'r',
    });
    expect(await centralWith({ baseUrl: BASE, fetch: fake.fetch })(['channels'], terminal)).toBe(1);
    expect(lastJson(terminal.lines)).toEqual({
      schema: CENTRAL_SCHEMA,
      job: 'channels',
      ok: false,
      refused: 'only the owner may dispatch the urgent promotion',
    });
    expect(fake.calls).toEqual([]);
  });

  it('fails the privacy self-test on a leak, the masks printed first', async () => {
    const fake = fakeGitHub({
      'GET installation/repositories': installation([{ id: 1, name: 'SVP-Labs/Secret' }]),
      'GET repos/SVP-Labs/Talos/actions/runs/5/attempts/1/jobs': {
        body: {
          total_count: 1,
          jobs: [{ id: 8, name: 'sweep-0', status: 'completed', conclusion: 'failure' }],
        },
      },
      'GET repos/SVP-Labs/Talos/actions/jobs/8/logs': { body: 'oops: secret' },
    });
    const terminal = io({
      GITHUB_TOKEN: 'w',
      TALOS_REVIEWER_TOKEN: 'r',
      GITHUB_REPOSITORY: 'SVP-Labs/Talos',
      GITHUB_RUN_ID: '5',
    });
    expect(await centralWith({ baseUrl: BASE, fetch: fake.fetch })(['privacy'], terminal)).toBe(1);
    expect(terminal.lines[0]).toBe('::add-mask::SVP-Labs/Secret\n::add-mask::Secret\n');
    expect(lastJson(terminal.lines)).toEqual({
      schema: CENTRAL_SCHEMA,
      job: 'privacy',
      ok: false,
      names: 1,
      jobs: 1,
      leaks: 1,
      canary: null,
    });
  });

  it('fails the privacy self-test when the canary is not watched', async () => {
    const fake = fakeGitHub({
      'GET installation/repositories': installation([{ id: 1, name: 'SVP-Labs/Secret' }]),
      'GET repos/SVP-Labs/Talos/actions/runs/5/attempts/1/jobs': {
        body: { total_count: 0, jobs: [] },
      },
    });
    const terminal = io({
      GITHUB_TOKEN: 'w',
      TALOS_RELEASE_TOKEN: 'r',
      GITHUB_REPOSITORY: 'SVP-Labs/Talos',
      GITHUB_RUN_ID: '5',
      TALOS_PRIVACY_CANARY_SHA256: nameDigest('SVP-Labs/talos-scratch-canary').toUpperCase(),
    });
    expect(await centralWith({ baseUrl: BASE, fetch: fake.fetch })(['privacy'], terminal)).toBe(1);
    expect(lastJson(terminal.lines)).toMatchObject({ ok: false, leaks: 0, canary: false });
  });

  it('runs the channels-file drift check on request', async () => {
    const fake = fakeGitHub({ 'GET repos/SVP-Labs/Talos': { status: 403 } });
    const terminal = io({ TALOS_RELEASE_TOKEN: 'r', TALOS_REVIEWER_TOKEN: 'v' });
    expect(
      await centralWith({ baseUrl: BASE, fetch: fake.fetch })(
        ['drift', '--channels-file'],
        terminal,
      ),
    ).toBe(1);
    expect(lastJson(terminal.lines)).toMatchObject({
      job: 'drift',
      ok: false,
      error: 'the drift report could not finish',
    });
    expect(fake.calls.map((c) => c.path)).toEqual(['repos/SVP-Labs/Talos']);
  });
});

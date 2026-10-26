import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CENTRAL_SCHEMA, centralWith } from './central.js';
import { type Io, UsageError } from './io.js';
import { nameDigest } from '../central/privacy.js';
import type { RuntimeAssessor } from '../central/runtime-port.js';
import {
  fakeGitHub,
  installation,
  propertiesPath,
  propertyValues,
  type Route,
} from '../central/test/fake-github.js';

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

/** The organisation's listing, every repository in it private. */
function organisation(...names: string[]): Record<string, Route> {
  const repos = propertyValues(names.map((name, index) => ({ id: index + 1, name })));
  return { [propertiesPath('SVP-Labs')]: repos, [propertiesPath('SVP-Labs', 'private')]: repos };
}

describe('talos central', () => {
  it('refuses an unknown job and a missing token as usage errors', async () => {
    const central = centralWith({});
    await expect(central(['deploy'], io({}))).rejects.toThrow(UsageError);
    await expect(central([], io({}))).rejects.toThrow(
      'talos central <channels|sweep|drift|privacy|pick>',
    );
    await expect(central(['sweep'], io({}))).rejects.toThrow('TALOS_REVIEWER_TOKEN is not set');
    await expect(central(['privacy'], io({ GITHUB_TOKEN: 'w' }))).rejects.toThrow(
      'TALOS_PROPERTIES_TOKEN is not set',
    );
    await expect(
      central(['privacy', '--mask'], io({ TALOS_PROPERTIES_TOKEN: 'p' })),
    ).rejects.toThrow('GITHUB_OUTPUT is not set');
    await expect(central(['pick'], io({ TALOS_PROPERTIES_TOKEN: 'p' }))).rejects.toThrow(
      'GITHUB_OUTPUT is not set',
    );
    await expect(central(['pick'], io({ GITHUB_OUTPUT: '/nowhere' }))).rejects.toThrow(
      'TALOS_PROPERTIES_TOKEN is not set',
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
      `${JSON.stringify({ schema: CENTRAL_SCHEMA, job: 'sweep', ok: true, governed: 0, files: 0, alerts: 0, filed: 0, open: 0, errors: 0, skipped: 0 })}\n`,
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

  it('needs the mirror token in the channels.json lookup, before any API call', async () => {
    const fake = fakeGitHub();
    const terminal = io({ GITHUB_TOKEN: 'w', TALOS_RELEASE_TOKEN: 'r', TALOS_LOOKUP: 'channels' });
    await expect(
      centralWith({ baseUrl: BASE, fetch: fake.fetch })(['channels'], terminal),
    ).rejects.toThrow('TALOS_MIRROR_TOKEN is not set');
    expect(fake.calls).toEqual([]);
  });

  it("masks every name, then hands the canary's bare name to the next steps", async () => {
    const canary = 'SVP-Labs/talos-scratch-canary';
    const fake = fakeGitHub(organisation('SVP-Labs/Secret', canary));
    const output = join(mkdtempSync(join(tmpdir(), 'talos-central-')), 'output');
    writeFileSync(output, 'before=1\n');
    const env = {
      TALOS_PROPERTIES_TOKEN: 'p',
      GITHUB_REPOSITORY: 'SVP-Labs/Talos',
      GITHUB_OUTPUT: output,
    };
    const central = centralWith({ baseUrl: BASE, fetch: fake.fetch });
    const found = io({ ...env, TALOS_PRIVACY_CANARY_SHA256: nameDigest(canary) });
    expect(await central(['privacy', '--mask', '--json'], found)).toBe(0);
    expect(found.lines[0]).toMatch(/^::add-mask::SVP-Labs\/Secret\n/);
    expect(lastJson(found.lines)).toEqual({
      schema: CENTRAL_SCHEMA,
      job: 'privacy',
      ok: true,
      names: 2,
      canary: true,
    });
    expect(readFileSync(output, 'utf8')).toBe('before=1\nname=talos-scratch-canary\n');
    const missing = io({ ...env, TALOS_PRIVACY_CANARY_SHA256: nameDigest('SVP-Labs/Gone') });
    expect(await central(['privacy', '--mask'], missing)).toBe(0);
    expect(lastJson(missing.lines)).toMatchObject({ ok: true, canary: false });
    expect(readFileSync(output, 'utf8')).toBe('before=1\nname=talos-scratch-canary\n');
    const printed = [...found.lines, ...missing.lines].filter((l) => !l.startsWith('::add-mask::'));
    expect(printed.join('')).not.toContain('scratch');
  });

  it('fails the privacy self-test on a leak, the masks printed first', async () => {
    const fake = fakeGitHub({
      ...organisation('SVP-Labs/Secret'),
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
      TALOS_PROPERTIES_TOKEN: 'p',
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
      ...organisation('SVP-Labs/Secret'),
      'GET installation/repositories': installation([{ id: 1, name: 'SVP-Labs/Secret' }]),
      'GET repos/SVP-Labs/Talos/actions/runs/5/attempts/1/jobs': {
        body: { total_count: 0, jobs: [] },
      },
    });
    const terminal = io({
      GITHUB_TOKEN: 'w',
      TALOS_PROPERTIES_TOKEN: 'p',
      TALOS_RELEASE_TOKEN: 'r',
      GITHUB_REPOSITORY: 'SVP-Labs/Talos',
      GITHUB_RUN_ID: '5',
      TALOS_PRIVACY_CANARY_SHA256: nameDigest('SVP-Labs/talos-scratch-canary').toUpperCase(),
    });
    expect(await centralWith({ baseUrl: BASE, fetch: fake.fetch })(['privacy'], terminal)).toBe(1);
    expect(lastJson(terminal.lines)).toMatchObject({ ok: false, leaks: 0, canary: false });
  });

  it('passes the privacy self-test only with the canary watched and no name in any log', async () => {
    const canary = 'SVP-Labs/talos-scratch-canary';
    const fake = fakeGitHub({
      ...organisation('SVP-Labs/Secret', canary),
      'GET installation/repositories': installation([{ id: 2, name: canary }]),
      'GET repos/SVP-Labs/Talos/actions/runs/5/attempts/1/jobs': {
        body: {
          total_count: 1,
          jobs: [{ id: 8, name: 'sweep-0', status: 'completed', conclusion: 'success' }],
        },
      },
      'GET repos/SVP-Labs/Talos/actions/jobs/8/logs': { body: 'repositories: 1\n' },
    });
    const env = {
      GITHUB_TOKEN: 'w',
      TALOS_PROPERTIES_TOKEN: 'p',
      TALOS_REVIEWER_TOKEN: 'r',
      GITHUB_REPOSITORY: 'SVP-Labs/Talos',
      GITHUB_RUN_ID: '5',
    };
    const watched = io({ ...env, TALOS_PRIVACY_CANARY_SHA256: nameDigest(canary) });
    expect(await centralWith({ baseUrl: BASE, fetch: fake.fetch })(['privacy'], watched)).toBe(0);
    expect(lastJson(watched.lines)).toMatchObject({ ok: true, leaks: 0, canary: true });
    const noToken = io({
      ...env,
      TALOS_REVIEWER_TOKEN: '',
      TALOS_PRIVACY_CANARY_SHA256: nameDigest(canary),
    });
    expect(await centralWith({ baseUrl: BASE, fetch: fake.fetch })(['privacy'], noToken)).toBe(1);
    expect(lastJson(noToken.lines)).toMatchObject({ ok: false, leaks: 0, canary: false });
    const unset = io({ ...env, TALOS_PRIVACY_CANARY_SHA256: '' });
    expect(await centralWith({ baseUrl: BASE, fetch: fake.fetch })(['privacy'], unset)).toBe(1);
    expect(lastJson(unset.lines)).toMatchObject({ ok: false, leaks: 0, canary: null });
  });

  it("masks the repository a matrix index names, then hands its bare name to the job's steps", async () => {
    const fake = fakeGitHub({
      [propertiesPath('SVP-Labs')]: propertyValues([
        { id: 30, name: 'SVP-Labs/Zeta', talos: 'stable' },
        { id: 10, name: 'SVP-Labs/Secret', talos: 'canary' },
        { id: 15, name: 'SVP-Labs/Ungoverned' },
      ]),
    });
    const output = join(mkdtempSync(join(tmpdir(), 'talos-central-')), 'output');
    writeFileSync(output, '');
    const central = centralWith({ baseUrl: BASE, fetch: fake.fetch });
    const env = { TALOS_PROPERTIES_TOKEN: 'p', GITHUB_OUTPUT: output };
    const json = (repositories: number) =>
      `${JSON.stringify({ schema: CENTRAL_SCHEMA, job: 'pick', ok: true, repositories })}\n`;
    const indexed = io({ ...env, TALOS_INDEX: '1' });
    expect(await central(['pick', '--json'], indexed)).toBe(0);
    expect(indexed.lines).toEqual(['::add-mask::SVP-Labs/Zeta\n::add-mask::Zeta\n', json(1)]);
    const canaries = io(env);
    expect(await central(['pick', '--channel', 'canary', '--json'], canaries)).toBe(0);
    expect(canaries.lines).toEqual(['::add-mask::SVP-Labs/Secret\n::add-mask::Secret\n', json(1)]);
    const past = io({ ...env, TALOS_INDEX: '2' });
    expect(await central(['pick', '--json'], past)).toBe(0);
    expect(past.lines).toEqual([json(0)]);
    expect(readFileSync(output, 'utf8')).toBe('names=Zeta\nnames=Secret\nnames=\n');
  });

  it('refuses a lost index or an unknown channel with the generic line, before any API call', async () => {
    const fake = fakeGitHub();
    const output = join(mkdtempSync(join(tmpdir(), 'talos-central-')), 'output');
    const central = centralWith({ baseUrl: BASE, fetch: fake.fetch });
    const env = { TALOS_PROPERTIES_TOKEN: 'p', GITHUB_OUTPUT: output };
    for (const [argv, extra] of [
      [['pick'], {}],
      [['pick'], { TALOS_INDEX: '' }],
      [['pick', '--channel', 'beta'], {}],
    ] as const) {
      const terminal = io({ ...env, ...extra });
      expect(await central([...argv, '--json'], terminal)).toBe(1);
      expect(terminal.lines).toEqual([
        `${JSON.stringify({ schema: CENTRAL_SCHEMA, job: 'pick', ok: false, error: 'the repository lookup could not finish' })}\n`,
      ]);
    }
    expect(fake.calls).toEqual([]);
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

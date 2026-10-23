import { describe, expect, it } from 'vitest';
import type { RuntimeAssessor } from './runtime-port.js';
import { runSweep } from './sweep-job.js';
import { securityLine } from './sweep.js';
import { type Fake, fakeGitHub, installation } from './test/fake-github.js';
import { identities } from '../github/identities.js';

const WHO = identities({});
const encoded = (
  text: string,
): { type: string; encoding: string; content: string; sha: string } => ({
  type: 'file',
  encoding: 'base64',
  content: Buffer.from(text).toString('base64'),
  sha: 'blob',
});

function repo(talos: string | undefined): Fake {
  return fakeGitHub({
    'GET installation/repositories': installation([{ id: 7, name: 'SVP-Labs/Secret', talos }]),
    'GET repos/SVP-Labs/Secret/git/trees/main?recursive=1': {
      body: {
        truncated: false,
        tree: [
          { path: 'Dockerfile', type: 'blob' },
          { path: 'src/app.ts', type: 'blob' },
          { path: '.nvmrc', type: 'blob' },
          { path: 'docker', type: 'tree' },
          { path: 'gone/Dockerfile', type: 'blob' },
        ],
      },
    },
    'GET repos/SVP-Labs/Secret/contents/Dockerfile?ref=main': {
      body: encoded('FROM php:8.4.26\n'),
    },
    'GET repos/SVP-Labs/Secret/contents/.nvmrc?ref=main': { body: encoded('22.1.0\n') },
    'GET repos/SVP-Labs/Secret/issues?state=open&labels=security': { body: [] },
    'POST repos/SVP-Labs/Secret/issues': (body) => ({
      status: 201,
      body: {
        number: 42,
        title: 'x',
        state: 'open',
        labels: (body as { labels: string[] }).labels.map((name) => ({ name })),
        created_at: 'now',
      },
    }),
  });
}

const alerts: RuntimeAssessor = (files) =>
  Promise.resolve({
    alerts: [
      ...(files.has('Dockerfile')
        ? [{ runtime: 'php', version: '8.4.26', fixed: '8.4.27', file: 'Dockerfile' }]
        : []),
      ...(files.has('.nvmrc')
        ? [{ runtime: 'node', version: '22.1.0', fixed: '22.4.1', file: '.nvmrc' }]
        : []),
    ],
    errors: 0,
  });

describe('runSweep', () => {
  it('files one p0 security issue per vulnerable runtime, reading only declaring files', async () => {
    const fake = repo('stable');
    const report = await runSweep({ gh: fake.gh, who: WHO, assess: alerts });
    expect(report).toEqual({ governed: 1, files: 2, alerts: 2, filed: 2, open: 0, errors: 0 });
    const filed = fake.calls
      .filter((c) => c.method === 'POST')
      .map((c) => c.body as { body: string; labels: string[] });
    expect(filed.map((f) => f.body.split('\n')[0])).toEqual([
      'talos-security/1 kind=runtime runtime=node version=22.1.0 fixed=22.4.1 priority=p0',
      'talos-security/1 kind=runtime runtime=php version=8.4.26 fixed=8.4.27 priority=p0',
    ]);
    expect(filed[0]?.labels).toContain('priority/p0');
    expect(fake.calls.some((c) => c.path.includes('src/app.ts'))).toBe(false);
  });

  it('files nothing an open Talos issue already covers', async () => {
    const fake = repo('canary');
    const issue = (number: number, author: string, body: string) => ({
      number,
      title: 't',
      body,
      state: 'open',
      labels: [{ name: 'security' }],
      user: { login: author },
      created_at: 'then',
    });
    const php = securityLine({ runtime: 'php', version: '8.4.26', fixed: '8.4.27', files: [] });
    const node = securityLine({ runtime: 'node', version: '22.1.0', fixed: '22.4.1', files: [] });
    fake.on('GET', 'repos/SVP-Labs/Secret/issues?state=open&labels=security', {
      body: [issue(1, 'talos-reviewer[bot]', php), issue(2, 'stranger', node)],
    });
    const report = await runSweep({ gh: fake.gh, who: WHO, assess: alerts });
    expect(report).toMatchObject({ alerts: 2, filed: 1, open: 1 });
  });

  it('leaves a repository Talos does not govern alone', async () => {
    const fake = repo(undefined);
    expect(await runSweep({ gh: fake.gh, who: WHO, assess: alerts })).toEqual({
      governed: 0,
      files: 0,
      alerts: 0,
      filed: 0,
      open: 0,
      errors: 0,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a token that reaches more than one repository', async () => {
    const fake = fakeGitHub({
      'GET installation/repositories': installation([
        { id: 1, name: 'o/a', talos: 'stable' },
        { id: 2, name: 'o/b', talos: 'stable' },
      ]),
    });
    await expect(runSweep({ gh: fake.gh, who: WHO, assess: alerts })).rejects.toThrow(
      'reaches 2 repositories',
    );
  });
});

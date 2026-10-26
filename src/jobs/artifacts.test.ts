import { describe, expect, it } from 'vitest';
import { recentArtifacts } from './artifacts.js';
import { downloader } from '../github/artifacts.js';
import { FakeGitHub, makeZip } from '../ticket/test/fake-github.js';

const zip = makeZip({ 'verdict.json': '{}' });

function fakeWithArtifacts(): FakeGitHub {
  const fake = new FakeGitHub();
  const base = { name: 'talos-verdict', expired: false, size_in_bytes: 200, zip };
  fake.artifacts.push(
    { ...base, id: 1, created_at: '2026-10-22T00:00:00Z' },
    { ...base, id: 2, created_at: '2026-10-25T00:00:00Z' },
    { ...base, id: 3, created_at: '2026-10-24T00:00:00Z' },
    { ...base, id: 4, created_at: '2026-10-25T00:00:00Z', expired: true },
    { ...base, id: 5, created_at: '2026-10-25T00:00:00Z', size_in_bytes: 6 * 1024 * 1024 },
    { ...base, id: 6, created_at: '2026-10-25T00:00:00Z', name: 'other' },
  );
  return fake;
}

describe('recentArtifacts', () => {
  it('lists the named, unexpired, small artifacts since a time, newest first', async () => {
    const fake = fakeWithArtifacts();
    const found = await recentArtifacts(fake.client('github-actions[bot]'), 'o/r', {
      name: 'talos-verdict',
      since: new Date('2026-10-23T00:00:00Z'),
      max: 10,
    });
    expect(found.map((a) => a.id)).toEqual([2, 3]);
    expect(fake.calls[0]?.query.get('name')).toBe('talos-verdict');
  });

  it('stops at the most it was asked for', async () => {
    const found = await recentArtifacts(fakeWithArtifacts().client(), 'o/r', {
      name: 'talos-verdict',
      since: new Date(0),
      max: 1,
    });
    expect(found.map((a) => a.id)).toEqual([2]);
  });
});

describe('downloader', () => {
  it('follows the redirect without sending the token to storage', async () => {
    const fake = fakeWithArtifacts();
    const download = downloader('workflow-token', { fetch: fake.fetch });
    const bytes = await download('https://api.github.com/repos/o/r/actions/artifacts/2/zip');
    expect(Buffer.from(bytes).equals(Buffer.from(zip))).toBe(true);
    expect(fake.calls.map((c) => [c.path, c.login])).toEqual([
      ['repos/o/r/actions/artifacts/2/zip', 'workflow-token'],
      ['storage/2', ''],
    ]);
  });

  it('fails on a missing artifact, and never sends the token beyond the API', async () => {
    const download = downloader('t', { fetch: fakeWithArtifacts().fetch });
    await expect(
      download('https://api.github.com/repos/o/r/actions/artifacts/9/zip'),
    ).rejects.toThrow(/404/);
    await expect(download('https://example.com/repos/o/r/actions/artifacts/2/zip')).rejects.toThrow(
      /not an API URL/,
    );
    await expect(download('https://api.github.com.evil.example/x')).rejects.toThrow(
      /not an API URL/,
    );
  });
});

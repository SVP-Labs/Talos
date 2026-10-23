import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Io, UsageError } from './io.js';
import { status } from './status.js';
import { why } from './why.js';

async function io(
  env: Record<string, string | undefined> = {},
): Promise<Io & { output: string[] }> {
  const output: string[] = [];
  return {
    cwd: await mkdtemp(join(tmpdir(), 'talos-cli-test-')),
    env,
    out: (text) => output.push(text),
    err: (text) => output.push(text),
    output,
  };
}

describe('talos status: usage', () => {
  it('takes either repositories or the organisation', async () => {
    await expect(status(['--org', '--repo', 'o/r'], await io())).rejects.toThrow(
      new UsageError('--org and --repo exclude each other'),
    );
  });

  it('refuses a repository that is not owner/name', async () => {
    await expect(status(['--repo', 'o/r', '--repo', 'nope'], await io())).rejects.toThrow(
      '--repo takes owner/name, not "nope"',
    );
  });

  it('refuses unknown flags', async () => {
    await expect(status(['--all'], await io())).rejects.toBeInstanceOf(UsageError);
  });
});

describe('talos why: usage', () => {
  it('takes one path', async () => {
    await expect(why([], await io())).rejects.toThrow('give one path');
    await expect(why(['a', 'b'], await io())).rejects.toThrow('give one path');
  });

  it('checks --limit and --repo', async () => {
    await expect(why(['a', '--limit', '0'], await io())).rejects.toThrow('--limit takes 1 to 20');
    await expect(why(['a', '--limit', 'x'], await io())).rejects.toThrow('--limit takes 1 to 20');
    await expect(why(['a', '--repo', 'x'], await io())).rejects.toThrow('--repo takes owner/name');
  });
});

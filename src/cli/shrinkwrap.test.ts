import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Io } from './io.js';
import { main } from './main.js';

function io(cwd: string): Io & { readonly errors: string[] } {
  const errors: string[] = [];
  return { cwd, env: {}, out: () => undefined, err: (text) => errors.push(text), errors };
}

const written = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(z.string(), z.record(z.string(), z.unknown())),
});

describe('talos shrinkwrap', () => {
  it('writes the shrinkwrap of a hoisted install beside its package.json and lockfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talos-shrinkwrap-'));
    const manifest = { name: '@svp-labs/talos', version: '1.0.0', dependencies: { a: '^1.0.0' } };
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
    await writeFile(
      join(dir, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      a: { specifier: ^1.0.0, version: 1.0.1 }',
        'packages:',
        '  a@1.0.1: { resolution: { integrity: sha512-a } }',
        'snapshots:',
        '  a@1.0.1: {}',
        '',
      ].join('\n'),
    );
    await mkdir(join(dir, 'node_modules', 'a'), { recursive: true });
    await writeFile(join(dir, 'node_modules/a/package.json'), '{"name":"a","version":"1.0.1"}');
    const term = io(dir);
    expect(await main(['shrinkwrap', '.', '--out', 'npm-shrinkwrap.json'], term)).toBe(0);
    const wrap = written.parse(
      JSON.parse(await readFile(join(dir, 'npm-shrinkwrap.json'), 'utf8')),
    );
    expect(wrap.packages['node_modules/a']).toMatchObject({
      version: '1.0.1',
      integrity: 'sha512-a',
    });
  });

  it('wants one directory and where to write', async () => {
    const term = io(tmpdir());
    expect(await main(['shrinkwrap', '--out', 'x.json'], term)).toBe(3);
    expect(await main(['shrinkwrap', 'a', 'b', '--out', 'x.json'], term)).toBe(3);
    expect(await main(['shrinkwrap', 'a'], term)).toBe(3);
    expect(term.errors).toHaveLength(3);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { UNSEEN_BY_KNIP } from './configs/knip.js';
import { TS_DEV_TOOLS } from './devtools.js';

const lockfile = z.object({
  importers: z.object({
    '.': z.object({
      devDependencies: z.record(z.string(), z.object({ version: z.string() })),
    }),
  }),
});

describe('the pinned TypeScript toolchain', () => {
  const lock = lockfile.parse(
    parse(readFileSync(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8')),
  );
  const installed = lock.importers['.'].devDependencies;

  it.each(Object.entries(TS_DEV_TOOLS.packages))(
    '%s is pinned at the version Talos itself installs',
    (name, version) => {
      expect(installed[name]?.version.split('(')[0]).toBe(version);
    },
  );

  it('pins every tool Talos runs', () => {
    for (const name of UNSEEN_BY_KNIP) expect(TS_DEV_TOOLS.packages).toHaveProperty(name);
  });
});

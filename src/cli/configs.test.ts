import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configs, writeConfigs } from './configs.js';
import type { Io } from './io.js';
import { committedRepo } from '../configs/test/git.js';
import type { Pack } from '../core/pack.js';
import { exec } from '../exec/exec.js';
import { MINIMAL_CONFIG } from '../testing/engine.js';

const pack: Pack = {
  name: 'fake',
  checks: [],
  generated: [
    {
      path: 'tool.cfg',
      scope: 'repo',
      applies: () => true,
      render: (ctx) => `version ${ctx.version}\n`,
      extension: { path: 'tool.project', initial: () => '# yours\n' },
    },
    {
      path: 'lint.cfg',
      scope: 'component',
      langs: ['py'],
      applies: () => true,
      render: () => 'strict\n',
    },
  ],
};

const capped = z.object({ items: z.array(z.string()), total: z.number() });

const CONFIG = `${MINIMAL_CONFIG}components:\n  - { lang: py, root: app }\n`;

function io(cwd: string): Io & { readonly output: string[] } {
  const output: string[] = [];
  return {
    cwd,
    env: {},
    output,
    out: (text) => output.push(text),
    err: (text) => output.push(text),
  };
}

describe('writeConfigs', () => {
  it('writes what changed and creates missing extension files, keeping existing ones', async () => {
    const { root } = await committedRepo({
      'talos.yml': CONFIG,
      'tool.cfg': 'version 0.9.0\n',
      'app/lint.cfg': 'strict\n',
    });
    expect(await writeConfigs(root, exec, [pack], '1.0.0')).toEqual({
      written: ['tool.cfg'],
      created: ['tool.project'],
    });
    expect(await readFile(join(root, 'tool.cfg'), 'utf8')).toBe('version 1.0.0\n');
    await writeFile(join(root, 'tool.project'), '# mine\n');
    expect(await writeConfigs(root, exec, [pack], '1.0.0')).toEqual({ written: [], created: [] });
    expect(await readFile(join(root, 'tool.project'), 'utf8')).toBe('# mine\n');
  });
});

describe('talos configs', () => {
  it('prints the paths it wrote as compact JSON', async () => {
    const { root } = await committedRepo({ 'talos.yml': MINIMAL_CONFIG });
    const terminal = io(root);
    expect(await configs(['--json'], terminal)).toBe(0);
    const printed = z
      .object({ written: capped, created: capped })
      .parse(JSON.parse(terminal.output.join('')));
    expect(printed.written.total).toBeGreaterThan(0);
    expect(printed.written.items).toHaveLength(Math.min(20, printed.written.total));
    const again = io(root);
    expect(await configs([], again)).toBe(0);
    expect(again.output.join('')).toBe('every generated config is up to date\n');
  });
});

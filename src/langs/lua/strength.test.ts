import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bound } from './run.js';
import { strength } from './strength.js';
import { parseConfig } from '../../config/load.js';
import { silentLogger } from '../../core/log.js';
import type { ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

async function judge(
  files: Readonly<Record<string, string>>,
  config: () => ExecResult,
): Promise<Awaited<ReturnType<typeof strength>>> {
  const root = await tempRepo({ 'game/.lua/bin/lua': '', ...files });
  const talos = parseConfig(MINIMAL_CONFIG);
  const ctx: Bound = {
    root,
    sha: '0'.repeat(40),
    exec: () => Promise.resolve(config()),
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch: await mkdtemp(join(tmpdir(), 'talos-lua-strength-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(files), talos.exclude),
    config: talos,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'lua', root: 'game', os: ['linux'] },
  };
  return strength(ctx);
}

/** luacheck's config script, with a `max_line_length` the project raised past the base. */
const RAISED = (): ExecResult => ({
  code: 0,
  stdout: JSON.stringify({
    error: '',
    top: [{ name: 'max_line_length', value: 200 }],
    files: [],
  }),
  stderr: '',
});

describe('lua/config-strength', () => {
  it("reports nothing when the project's configuration fails to load", async () => {
    const broken = (): ExecResult => ({
      code: 0,
      stdout: JSON.stringify({ error: "unknown std 'lua99'" }),
      stderr: '',
    });
    expect(await judge({}, broken)).toEqual([]);
  });

  it('locates a weaker setting at the project file, when it has one', async () => {
    const files = { 'game/luacheck_project.lua': 'return {\n    max_line_length = 200,\n}\n' };
    const findings = await judge(files, RAISED);
    expect(findings).toEqual([
      {
        rule: 'config/weaker',
        message:
          'game/luacheck_project.lua raises max_line_length to 200, over 120; it may only tighten .luacheckrc.',
        key: 'game/luacheck_project.lua max_line_length',
        location: { file: 'game/luacheck_project.lua', line: 1, endLine: 3 },
      },
    ]);
  });

  it('reports a weaker setting with no location when there is no luacheckrc project file', async () => {
    const findings = await judge({}, RAISED);
    expect(findings).toEqual([
      {
        rule: 'config/weaker',
        message:
          'game/luacheck_project.lua raises max_line_length to 200, over 120; it may only tighten .luacheckrc.',
        key: 'game/luacheck_project.lua max_line_length',
      },
    ]);
  });
});

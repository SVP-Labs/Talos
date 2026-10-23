import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bound } from './run.js';
import { strength } from './strength.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

/** An excerpt of `ruff check --show-settings` (ruff 0.17.2) under the base config. */
const BASE_SETTINGS = [
  'Resolved settings for: "/repo/a.py"',
  '',
  '# Linter Settings',
  'linter.rules.enabled = [',
  '\tcomplex-structure (C901),',
  '\tunused-import (F401),',
  ']',
  'linter.mccabe.max_complexity = 12',
  '',
].join('\n');

const LOOSE_SETTINGS = BASE_SETTINGS.replace('\tcomplex-structure (C901),\n', '').replace(
  'max_complexity = 12',
  'max_complexity = 20',
);

type Seen = { readonly configs: string[]; readonly files: string[] };

async function judge(
  files: Readonly<Record<string, string>>,
  ruff: (config: string) => ExecResult,
  seen: Seen = { configs: [], files: [] },
): Promise<Awaited<ReturnType<typeof strength>>> {
  const root = await tempRepo({ ...files, 'svc/.venv/bin/ruff': '' });
  const config = parseConfig(MINIMAL_CONFIG);
  const ctx: Bound = {
    root,
    sha: '0'.repeat(40),
    exec: (_command, args) => {
      const config = args[args.indexOf('--config') + 1] ?? '';
      seen.configs.push(config);
      seen.files.push(args.at(-1) ?? '');
      return Promise.resolve(ruff(config));
    },
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch: await mkdtemp(join(tmpdir(), 'talos-py-strength-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(files), config.exclude),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'py', root: 'svc', os: ['linux'] },
  };
  return strength(ctx);
}

/** The base Talos renders afresh in its scratch directory, and a looser config anywhere else. */
const settingsFor = (config: string): ExecResult => ({
  code: 0,
  stdout: isAbsolute(config) ? BASE_SETTINGS : LOOSE_SETTINGS,
  stderr: '',
});

describe('py/config-strength', () => {
  it("compares ruff's effective settings, the pyright chain and file comments with the base", async () => {
    const seen: Seen = { configs: [], files: [] };
    const files = {
      'svc/app/main.py': '# pyright: basic\nimport os\n',
      'svc/app/strict.py':
        '# pyright: strict, reportUnusedImport=true\n# pyright: ignore[reportAny]\n',
      'svc/ruff.toml': '[lint]\nignore = ["C901"]\n',
      'svc/pyrightconfig.json':
        '{\n  // looser on imports\n  "extends": "pyrightconfig.talos.json",\n  "reportMissingImports": "warning"\n}\n',
      'svc/pyrightconfig.talos.json': '{ "typeCheckingMode": "all" }\n',
    };
    const findings = await judge(files, settingsFor, seen);
    expect(seen.configs.filter((c) => !isAbsolute(c))).toEqual(['ruff.toml']);
    expect(seen.configs.filter((c) => isAbsolute(c)).map((c) => basename(c))).toEqual([
      'ruff.talos.toml',
    ]);
    expect(seen.files).toEqual(['app/main.py', 'app/main.py']);
    expect(findings).toEqual([
      {
        rule: 'config/weaker',
        message:
          'svc/ruff.toml turns off complex-structure (C901), which is weaker than ruff.talos.toml.',
        key: 'svc/ruff.toml rule C901',
      },
      {
        rule: 'config/weaker',
        message:
          'svc/ruff.toml raises linter.mccabe.max_complexity from 12 to 20, which is weaker than ruff.talos.toml.',
        key: 'svc/ruff.toml linter.mccabe.max_complexity',
      },
      {
        rule: 'config/weaker',
        message:
          'svc/pyrightconfig.json sets reportMissingImports to "warning", which is weaker than pyrightconfig.talos.json.',
        key: 'svc/pyrightconfig.json reportMissingImports',
      },
      {
        rule: 'config/weaker',
        message:
          'This comment sets "basic" for the file, which is weaker than pyrightconfig.talos.json.',
        location: { file: 'svc/app/main.py', line: 1 },
      },
      {
        rule: 'config/weaker',
        message:
          'This comment sets "strict, reportUnusedImport=true" for the file, which is weaker than pyrightconfig.talos.json.',
        location: { file: 'svc/app/strict.py', line: 1 },
      },
    ]);
  });

  it("judges an edited copy of the base, and pyproject.toml's basedpyright table", async () => {
    const files = {
      'svc/app/main.py': 'import os\n',
      'svc/ruff.talos.toml': '# edited\n',
      'svc/pyproject.toml': '[tool.basedpyright]\ntypeCheckingMode = "standard"\n',
    };
    const findings = await judge(files, settingsFor);
    expect(findings.map((f) => f.key)).toEqual([
      'svc/ruff.talos.toml rule C901',
      'svc/ruff.talos.toml linter.mccabe.max_complexity',
      'svc/pyproject.toml typeCheckingMode',
    ]);
  });

  it("can't judge when ruff can't show its settings, or with no Python file", async () => {
    const broken = (): ExecResult => ({ code: 2, stdout: '', stderr: 'ruff failed: bad config' });
    await expect(judge({ 'svc/app/main.py': '' }, broken)).rejects.toThrow(
      'ruff check --show-settings exited 2',
    );
    await expect(judge({ 'svc/README.md': '' }, settingsFor)).rejects.toThrow(EngineError);
  });
});

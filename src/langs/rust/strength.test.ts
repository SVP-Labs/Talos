import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bound } from './run.js';
import { strength } from './strength.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { ExecResult } from '../../exec/exec.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo } from '../../testing/engine.js';

/** Talos's levels, as a `[workspace.lints]` that loosens nothing. */
const FULL_LINTS = [
  '[workspace.lints.rust]',
  'unsafe_code = "deny"',
  '',
  '[workspace.lints.clippy]',
  'all = { level = "warn", priority = -1 }',
  'pedantic = { level = "warn", priority = -1 }',
  'cognitive_complexity = "warn"',
  'unwrap_used = "warn"',
  'expect_used = "warn"',
  'dbg_macro = "warn"',
  'todo = "warn"',
  'unimplemented = "deny"',
  '',
];

const PRINTED_DEFAULTS = 'max_width = 100\nhard_tabs = false\nedition = "2015"\n';

function metadata(root: string, members: readonly string[]): string {
  return JSON.stringify({
    workspace_root: root,
    packages: members.map((member) => ({
      name: member === '' ? 'solo' : member,
      manifest_path: join(root, member, 'Cargo.toml'),
      targets: [],
    })),
  });
}

type World = {
  readonly files: Readonly<Record<string, string>>;
  readonly members: readonly string[];
  /** What `rustfmt --print-config default` answers. */
  readonly rustfmt?: ExecResult;
};

async function judge(
  world: World,
): Promise<{ rule: string; key?: string; file?: string; line?: number }[]> {
  const root = await tempRepo(world.files);
  const config = parseConfig(MINIMAL_CONFIG);
  const ctx: Bound = {
    root,
    sha: '0'.repeat(40),
    exec: (command) => {
      if (command === 'rustfmt') {
        return Promise.resolve(world.rustfmt ?? { code: 0, stdout: PRINTED_DEFAULTS, stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: metadata(root, world.members), stderr: '' });
    },
    tools: { path: (name) => Promise.resolve(`/tools/${name}`), version: () => '1.0.0' },
    scratch: await mkdtemp(join(tmpdir(), 'talos-rust-strength-')),
    log: silentLogger,
    os: 'linux',
    facts: repoFacts(Object.keys(world.files), []),
    config,
    side: 'alone',
    tiers: ['commit', 'head'],
    memo: (_key, compute) => compute(),
    component: { lang: 'rust', root: '.', os: ['linux'] },
  };
  return (await strength(ctx)).map((f) => ({
    rule: f.rule,
    ...(f.key === undefined ? {} : { key: f.key }),
    ...(f.location === undefined ? {} : { file: f.location.file, line: f.location.line }),
  }));
}

describe('rust/config-strength', () => {
  it('passes a workspace that holds every level and loosens nothing', async () => {
    const files = {
      'Cargo.toml': ['[workspace]', 'members = ["app"]', '', ...FULL_LINTS].join('\n'),
      'app/Cargo.toml': '[package]\nname = "app"\n\n[lints]\nworkspace = true\n',
      'rustfmt.toml': 'max_width = 80\n',
      'app/src/lib.rs': 'pub fn f() {}\n',
    };
    expect(await judge({ files, members: ['app'] })).toEqual([]);
  });

  it("reports what the workspace's lint table lowers or allows, read through each member", async () => {
    const lowered = FULL_LINTS.map((line) =>
      line.startsWith('pedantic') ? 'pedantic = "allow"' : line,
    );
    const files = {
      'Cargo.toml': [
        '[workspace]',
        'members = ["app", "core"]',
        '',
        ...lowered,
        'missing_docs_in_private_items = "allow"',
        '',
        '[workspace.metadata.cargo-machete]',
        'ignored = ["serde"]',
        '',
      ].join('\n'),
      'app/Cargo.toml': '[package]\nname = "app"\n\n[lints]\nworkspace = true\n',
      'core/Cargo.toml': [
        '[package]',
        'name = "core"',
        '',
        '[package.metadata.cargo-machete]',
        'ignored = ["rand"]',
        '',
      ].join('\n'),
    };
    expect(await judge({ files, members: ['app', 'core'] })).toEqual([
      { rule: 'config/weaker', key: 'core/Cargo.toml lints', file: 'core/Cargo.toml', line: 1 },
      {
        rule: 'config/weaker',
        key: 'core/Cargo.toml cargo-machete ignored rand',
        file: 'core/Cargo.toml',
        line: 5,
      },
      {
        rule: 'config/weaker',
        key: 'Cargo.toml workspace.lints.clippy.pedantic',
        file: 'Cargo.toml',
        line: 9,
      },
      {
        rule: 'config/weaker',
        key: 'Cargo.toml workspace.lints.clippy.missing_docs_in_private_items',
        file: 'Cargo.toml',
        line: 17,
      },
      {
        rule: 'config/weaker',
        key: 'Cargo.toml cargo-machete ignored serde',
        file: 'Cargo.toml',
        line: 20,
      },
    ]);
  });

  it('reports rustfmt and Clippy files the gate ignores where they differ from its own', async () => {
    const files = {
      'Cargo.toml': ['[workspace]', 'members = ["app"]', '', ...FULL_LINTS].join('\n'),
      'app/Cargo.toml': '[package]\nname = "app"\n\n[lints]\nworkspace = true\n',
      'rustfmt.toml': 'max_width = 80\n',
      'app/.rustfmt.toml': 'hard_tabs = false\nmax_width = 120\n',
      'app/clippy.toml': 'cognitive-complexity-threshold = 15\ntoo-many-lines-threshold = 100\n',
      'app/src/clippy.toml': 'this is = = not toml\n',
    };
    expect(await judge({ files, members: ['app'] })).toEqual([
      {
        rule: 'config/weaker',
        key: 'app/.rustfmt.toml rustfmt max_width',
        file: 'app/.rustfmt.toml',
        line: 2,
      },
      {
        rule: 'config/weaker',
        key: 'app/clippy.toml clippy too-many-lines-threshold',
        file: 'app/clippy.toml',
        line: 2,
      },
    ]);
  });

  it('reports rustflags that lower lint levels in the cargo config', async () => {
    const files = {
      'Cargo.toml': [
        '[package]',
        'name = "solo"',
        '',
        '[lints]',
        'workspace = true',
        '',
        ...FULL_LINTS,
      ].join('\n'),
      '.cargo/config.toml': '[build]\nrustflags = ["--cap-lints=allow", "-C", "opt-level=1"]\n',
    };
    const found = await judge({ files, members: [''] });
    expect(found).toEqual([
      {
        rule: 'config/weaker',
        key: '.cargo/config.toml build.rustflags --cap-lints=allow',
        file: '.cargo/config.toml',
        line: 2,
      },
    ]);
  });

  it("can't judge rustfmt files when rustfmt can't print its defaults", async () => {
    const files = {
      'Cargo.toml': ['[workspace]', 'members = []', '', ...FULL_LINTS].join('\n'),
      'lib/rustfmt.toml': 'max_width = 120\n',
    };
    const broken = { code: 1, stdout: '', stderr: 'error: toolchain not installed' };
    await expect(judge({ files, members: [], rustfmt: broken })).rejects.toThrow(
      'rustfmt --print-config default exited 1',
    );
    const garbled = { code: 0, stdout: 'not = = toml', stderr: '' };
    await expect(judge({ files, members: [], rustfmt: garbled })).rejects.toThrow(EngineError);
  });
});

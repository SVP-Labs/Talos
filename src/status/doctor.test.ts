import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DoctorDeps, doctorReport, nodeItem } from './doctor.js';
import { missingTools, onPath, resolvable } from './resolve.js';
import type { Pack } from '../core/pack.js';
import type { Exec } from '../exec/exec.js';
import type { GitHub } from '../github/api.js';

const PIN = 'a'.repeat(40);

async function directory(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talos-doctor-test-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const versions: Exec = (command) =>
  Promise.resolve(
    command === 'git'
      ? { code: 0, stdout: 'git version 2.43.0\n', stderr: '' }
      : { code: 0, stdout: 'gh version 2.60.0 (2026-01-01)\nhttps://…\n', stderr: '' },
  );

function fakeGitHub(answers: Record<string, unknown>): GitHub {
  const answer = (key: string): unknown => {
    if (!(key in answers)) throw new Error(`unexpected ${key}`);
    return answers[key];
  };
  return {
    request: <T>(method: string, path: string) => Promise.resolve(answer(`${method} ${path}`) as T),
    paginate: <T>(path: string) => Promise.resolve(answer(`GET ${path}`) as T[]),
    graphql: () => Promise.reject(new Error('no graphql')),
  };
}

const lookup = {
  'GET repos/SVP-Labs/Talos': { id: 900, full_name: 'SVP-Labs/Talos' },
  'GET repos/o/r/rulesets?includes_parents=true': [
    { id: 1, name: 'talos-canary', enforcement: 'active' },
  ],
  'GET repos/o/r/rulesets/1?includes_parents=true': {
    id: 1,
    name: 'talos-canary',
    enforcement: 'active',
    rules: [
      {
        type: 'workflows',
        parameters: { workflows: [{ path: 'gate.yml', repository_id: 900, sha: PIN }] },
      },
    ],
  },
  [`GET repos/SVP-Labs/Talos/contents/package.json?ref=${PIN}`]: {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify({ name: '@svp-labs/talos', version: '1.2.0' })).toString(
      'base64',
    ),
    sha: 'b',
  },
};

const tsPack: Pack = {
  name: 'ts',
  lang: 'ts',
  checks: [],
  devTools: { manager: 'npm', packages: { eslint: '10.0.0', prettier: '3.0.0' } },
};

async function deps(overrides: Partial<DoctorDeps> = {}): Promise<DoctorDeps> {
  const cwd = await directory({
    'talos.yml':
      'name: Demo\nprefix: D\ncomponents:\n  - { lang: ts, root: . }\n  - { lang: lua, root: mod }\n',
    'node_modules/eslint/package.json': '{}',
  });
  return {
    cwd,
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PATH: '' },
    exec: versions,
    node: { version: '22.22.0', range: '>=22.12' },
    running: '1.2.0',
    loadPacks: () => Promise.resolve([tsPack]),
    client: () => fakeGitHub(lookup),
    ...overrides,
  };
}

describe('doctorReport', () => {
  it('reports each concern of a machine that is set up', async () => {
    expect(await doctorReport(await deps())).toEqual([
      { id: 'node', status: 'ok', detail: '22.22.0' },
      { id: 'git', status: 'ok', detail: 'git version 2.43.0' },
      { id: 'gh', status: 'ok', detail: 'gh version 2.60.0 (2026-01-01)' },
      { id: 'config', status: 'ok', detail: 'talos.yml: Demo, prefix D' },
      { id: 'repository', status: 'ok', detail: 'o/r' },
      { id: 'token', status: 'ok', detail: 'from GITHUB_TOKEN' },
      {
        id: 'pin',
        status: 'ok',
        detail: `rulesets: talos-canary (active) pins ${PIN.slice(0, 12)}`,
      },
      { id: 'version', status: 'ok', detail: 'running 1.2.0, as enforced' },
      {
        id: 'tools:ts@.',
        status: 'warn',
        detail: "missing prettier: install the component's dependencies",
      },
      { id: 'tools:lua@mod', status: 'skip', detail: 'the pack declares no editor tools' },
    ]);
  });

  it('warns when the running version is not the enforced one', async () => {
    const items = await doctorReport(await deps({ running: '1.1.0' }));
    expect(items.find((i) => i.id === 'version')).toEqual({
      id: 'version',
      status: 'warn',
      detail: 'running 1.1.0, enforced 1.2.0: commands that act on the repository run 1.2.0',
    });
  });

  it('fails a pin that is missing or ambiguous, and says why', async () => {
    const none = { ...lookup, 'GET repos/o/r/rulesets?includes_parents=true': [] };
    const items = await doctorReport(await deps({ client: () => fakeGitHub(none) }));
    expect(items.filter((i) => ['pin', 'version'].includes(i.id))).toEqual([
      {
        id: 'pin',
        status: 'fail',
        detail: 'rulesets: no ruleset that applies to this repository runs the Talos gate',
      },
      { id: 'version', status: 'skip', detail: 'no pin' },
    ]);
    const broken = await doctorReport(
      await deps({
        client: () => {
          throw new Error('GET repos/SVP-Labs/Talos: 403');
        },
      }),
    );
    expect(broken.find((i) => i.id === 'pin')).toEqual({
      id: 'pin',
      status: 'fail',
      detail: 'GET repos/SVP-Labs/Talos: 403',
    });
  });

  it("takes the hub's version without a lookup", async () => {
    const items = await doctorReport(
      await deps({
        env: {
          GITHUB_TOKEN: 't',
          GITHUB_REPOSITORY: 'o/r',
          TALOS_VERSION: '1.2.0',
          TALOS_SHA: PIN,
        },
      }),
    );
    expect(items.filter((i) => ['pin', 'version'].includes(i.id))).toEqual([
      { id: 'pin', status: 'skip', detail: 'handed over by the environment' },
      {
        id: 'version',
        status: 'ok',
        detail: `TALOS_VERSION 1.2.0 at ${PIN.slice(0, 12)}, running 1.2.0`,
      },
    ]);
  });

  it('fails what is missing on a bare machine', async () => {
    const missing: Exec = () => Promise.reject(new Error('could not start'));
    const cwd = await directory({});
    const items = await doctorReport(
      await deps({
        cwd,
        exec: missing,
        env: { GH_TOKEN: 't' },
        node: { version: '20.0.0', range: '>=22.12' },
      }),
    );
    expect(items).toEqual([
      { id: 'node', status: 'fail', detail: '20.0.0; Talos needs >=22.12' },
      { id: 'git', status: 'fail', detail: 'git is not on PATH' },
      {
        id: 'gh',
        status: 'warn',
        detail: 'the GitHub CLI is not on PATH; GITHUB_TOKEN works instead',
      },
      {
        id: 'config',
        status: 'fail',
        detail: expect.stringContaining('talos.yml not found') as string,
      },
      { id: 'repository', status: 'fail', detail: 'no GitHub origin here' },
      { id: 'token', status: 'ok', detail: 'from GH_TOKEN' },
      { id: 'pin', status: 'skip', detail: 'needs a repository and a token' },
    ]);
  });

  it('reads a version line only from a command that succeeded', async () => {
    const failing: Exec = () => Promise.resolve({ code: 1, stdout: 'x', stderr: '' });
    const items = await doctorReport(await deps({ exec: failing }));
    expect(items.find((i) => i.id === 'git')?.status).toBe('fail');
  });
});

describe('doctorReport without its packs', () => {
  it('still reports the rest when the check packs fail to load', async () => {
    const items = await doctorReport(
      await deps({ loadPacks: () => Promise.reject(new SyntaxError('broken pack\nat line 3')) }),
    );
    expect(items.at(-1)).toEqual({
      id: 'tools',
      status: 'fail',
      detail: "Talos's check packs did not load: broken pack",
    });
  });
});

describe('nodeItem', () => {
  it('checks the range Talos asks for', () => {
    expect(nodeItem({ version: '22.12.0', range: '>=22.12' }).status).toBe('ok');
    expect(nodeItem({ version: '22.11.0', range: '>=22.12' }).status).toBe('fail');
  });
});

describe('resolving editor tools', () => {
  it("finds npm packages in the component's or a parent's node_modules, not above the repository", async () => {
    const top = await directory({
      'node_modules/prettier/package.json': '{}',
      'web/node_modules/eslint/package.json': '{}',
    });
    const ctx = { root: join(top, 'web'), top, env: {}, home: top };
    expect(
      await missingTools(
        { manager: 'npm', packages: { eslint: '1', prettier: '1', knip: '1' } },
        ctx,
      ),
    ).toEqual(['knip']);
    const nested = { ...ctx, top: join(top, 'web') };
    expect(await resolvable('npm', 'prettier', nested)).toBe(false);
  });

  it('finds Python distributions in the .venv, on Linux and Windows layouts', async () => {
    const root = await directory({
      '.venv/lib/python3.13/site-packages/basedpyright-1.2.3.dist-info/METADATA': '',
      '.venv/Lib/site-packages/import_linter-2.0.dist-info/METADATA': '',
    });
    const ctx = { root, top: root, env: { PATH: '' }, home: root };
    expect(await resolvable('pypi', 'basedpyright', ctx)).toBe(true);
    expect(await resolvable('pypi', 'import-linter', ctx)).toBe(true);
    expect(await resolvable('pypi', 'ruff', ctx)).toBe(false);
  });

  it('finds Composer packages, cargo and luarocks tools', async () => {
    const root = await directory({
      'vendor/phpstan/phpstan/composer.json': '{}',
      'home/.cargo/bin/cargo-machete': '',
      'lua_modules/bin/busted': '',
      'bin/luacheck.exe': '',
    });
    const ctx = {
      root,
      top: root,
      env: { PATH: join(root, 'bin'), PATHEXT: '.COM;.EXE' },
      home: join(root, 'home'),
    };
    expect(await resolvable('composer', 'phpstan/phpstan', ctx)).toBe(true);
    expect(await resolvable('composer', 'larastan/larastan', ctx)).toBe(false);
    expect(await resolvable('cargo', 'cargo-machete', ctx)).toBe(true);
    expect(await resolvable('cargo', 'cargo-mutants', ctx)).toBe(false);
    expect(await resolvable('luarocks', 'busted', ctx)).toBe(true);
    expect(await resolvable('luarocks', 'luacheck', ctx)).toBe(true);
  });

  it('looks programs up on PATH with Windows extensions', async () => {
    const root = await directory({ 'a/tool.cmd': '', 'b/other': '' });
    const env = { Path: [join(root, 'a'), join(root, 'b')].join(delimiter), PATHEXT: '.CMD' };
    expect(await onPath('tool', env)).toBe(true);
    expect(await onPath('other', env)).toBe(true);
    expect(await onPath('missing', env)).toBe(false);
    expect(await onPath('tool', {})).toBe(false);
  });
});

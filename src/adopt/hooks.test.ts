import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAdoptAssets } from './assets.js';
import { startDraft } from './draft.js';
import { type HookAssets, PRE_PUSH, prePushHook } from './hooks.js';
import { clone, sh } from './test/git.js';
import { PACKS } from '../core/registry.js';
import { exec } from '../exec/exec.js';

const HOOK = "#!/bin/sh\n# Talos's pre-push hook, written by talos adopt, which rewrites it.\n";
const ASSETS: HookAssets = { prePush: HOOK };
const PREPARE = 'git config core.hooksPath .githooks || exit 0';

function plan(texts: Record<string, string>) {
  const draft = startDraft(Object.keys(texts), (path) => texts[path]);
  prePushHook(draft, ASSETS);
  return draft.done();
}

function applied(texts: Record<string, string>): Record<string, string> {
  const next = { ...texts };
  for (const file of plan(texts).write) next[file.path] = file.content;
  return next;
}

function written(texts: Record<string, string>, path: string): unknown {
  const content = plan(texts).write.find((f) => f.path === path)?.content;
  return content === undefined ? undefined : JSON.parse(content);
}

describe('the pre-push hook adoption writes', () => {
  it('writes the hook as an executable, and has installing set core.hooksPath', () => {
    const texts = { 'package.json': '{\n  "name": "web",\n  "scripts": { "test": "vitest" }\n}\n' };
    const result = plan(texts);
    expect(result.write).toEqual([
      { path: PRE_PUSH, content: HOOK, why: 'hook', mode: 'executable' },
      expect.objectContaining({ path: 'package.json', why: 'hook' }),
    ]);
    expect(written(texts, 'package.json')).toEqual({
      name: 'web',
      scripts: { test: 'vitest', prepare: PREPARE },
    });
    expect(result.next).toEqual([]);
    expect(written({ 'package.json': '{}\n' }, 'package.json')).toEqual({
      scripts: { prepare: PREPARE },
    });
  });

  it('plans nothing on a second run', () => {
    for (const texts of [{ 'package.json': '{}\n' }, { 'Cargo.toml': '' }]) {
      const second = plan(applied(texts));
      expect(second.write).toEqual([]);
      expect(second.next).toEqual([]);
    }
  });

  it('leaves the hooks path to the clone where nothing is installed, or no script can be read', () => {
    for (const texts of [
      { 'pyproject.toml': '' },
      { 'package.json': 'not json' },
      { 'package.json': '{ "scripts": [] }\n' },
    ]) {
      const result = plan(texts);
      expect(result.write.map((f) => f.path)).toEqual([PRE_PUSH]);
      expect(result.next).toEqual([]);
    }
  });

  it("asks for core.hooksPath in a prepare script the project has, and doesn't rewrite it", () => {
    const own = plan({ 'package.json': '{ "scripts": { "prepare": "tsc" } }\n' });
    expect(own.write.map((f) => f.path)).toEqual([PRE_PUSH]);
    expect(own.next).toEqual([
      `add \`${PREPARE}\` to package.json's prepare script, so installing has git run ${PRE_PUSH}`,
    ]);
    const elsewhere = plan({
      'package.json': '{ "scripts": { "prepare": "git config core.hooksPath hooks" } }\n',
    });
    expect(elsewhere.next).toEqual([expect.stringMatching(/points core\.hooksPath elsewhere/)]);
    const set = plan({ 'package.json': `{ "scripts": { "prepare": "${PREPARE}" } }\n` });
    expect(set.write.map((f) => f.path)).toEqual([PRE_PUSH]);
    expect(set.next).toEqual([]);
  });

  it("never takes a hook manager's place: it asks the manager to call the hook", () => {
    const managers: [string, Record<string, string>][] = [
      ['lefthook', { 'lefthook.yml': 'pre-commit:\n' }],
      ['pre-commit', { '.pre-commit-config.yaml': 'repos: []\n' }],
      ['husky', { '.husky/pre-commit': 'pnpm lint\n' }],
      ['husky', { 'package.json': '{ "scripts": { "prepare": "husky" } }\n' }],
      ['simple-git-hooks', { 'package.json': '{ "simple-git-hooks": {} }\n' }],
      ['overcommit', { '.overcommit.yml': 'PrePush: {}\n' }],
    ];
    for (const [name, texts] of managers) {
      const result = plan(texts);
      expect(result.write.map((f) => f.path)).toEqual([PRE_PUSH]);
      expect(result.next).toEqual([
        `${name} runs the git hooks here: make its pre-push run ${PRE_PUSH}, Talos's fast tier, and leave core.hooksPath to ${name}`,
      ]);
    }
    const wired = plan({
      'lefthook.yml': `pre-push:\n  commands:\n    talos:\n      run: ${PRE_PUSH}\n`,
    });
    expect(wired.next).toEqual([]);
  });

  it("keeps the project's own pre-push, and rewrites only Talos's", () => {
    const own = plan({ [PRE_PUSH]: '#!/bin/sh\nmake lint\n' });
    expect(own.write).toEqual([]);
    expect(own.next).toEqual([
      `${PRE_PUSH} is the project's own: make it run Talos's fast tier too (npx @svp-labs/talos check --tiers commit)`,
    ]);
    expect(plan({ [PRE_PUSH]: '#!/bin/sh\nmake lint\ntalos check --tiers commit\n' }).next).toEqual(
      [],
    );
    const older = plan({ [PRE_PUSH]: `${HOOK}talos check\n` });
    expect(older.write).toEqual([
      { path: PRE_PUSH, content: HOOK, why: 'hook', mode: 'executable' },
    ]);
  });
});

/** A file of the Talos repository. */
const repo = (path: string): URL => new URL(`../../${path}`, import.meta.url);

describe("Talos's own hook", () => {
  it('runs the one adoption writes, and adopting Talos plans nothing for it', async () => {
    const own = await readFile(repo(PRE_PUSH), 'utf8');
    expect(own).toContain('exec sh assets/hooks/pre-push "$@"');
    const texts: Record<string, string> = {
      [PRE_PUSH]: own,
      'package.json': await readFile(repo('package.json'), 'utf8'),
    };
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    prePushHook(draft, await loadAdoptAssets());
    expect(draft.done()).toEqual({ write: [], delete: [], next: [] });
  });
});

/**
 * A clone whose pushes run the hook: `hooks` maps where each file goes to the Talos file it
 * copies, every one executable.
 */
async function hooked(
  files: Record<string, string>,
  hooks: Record<string, string> = { [PRE_PUSH]: 'assets/hooks/pre-push' },
): Promise<string> {
  const { root } = await clone(files);
  for (const [path, from] of Object.entries(hooks)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), await readFile(repo(from)), { mode: 0o755 });
    sh(root, 'add', '--chmod=+x', '--', path);
  }
  sh(root, 'commit', '--quiet', '-m', 'hook');
  sh(root, 'config', 'core.hooksPath', '.githooks');
  return root;
}

/** A stand-in for Talos that records how it ran and exits as `exit.txt` says. */
const STAND_IN = `import { appendFileSync, readFileSync } from 'node:fs';
const dev = process.env.TALOS_DEV ?? '';
appendFileSync('ran.txt', process.argv.slice(2).join(' ') + ' dev=' + dev + '\\n');
process.exitCode = Number(readFileSync('exit.txt', 'utf8'));
`;

/** The OS the hook sees: Talos's own hook leaves its unit tests out on Windows only. */
const LINUX = { OS: '' };

async function push(root: string, env: Readonly<Record<string, string>>, ...refs: string[]) {
  return (await exec('git', ['push', '--quiet', 'origin', ...refs], { cwd: root, env })).code;
}

async function ran(root: string): Promise<string[]> {
  return (await readFile(join(root, 'ran.txt'), 'utf8')).trim().split('\n');
}

/** A clone of Talos itself, its build a stand-in. */
async function talosClone(): Promise<string> {
  const root = await hooked(
    { 'package.json': '{\n  "name": "@svp-labs/talos"\n}\n' },
    { [PRE_PUSH]: PRE_PUSH, 'assets/hooks/pre-push': 'assets/hooks/pre-push' },
  );
  await mkdir(join(root, 'dist/bin'), { recursive: true });
  await writeFile(join(root, 'dist/bin/talos.js'), STAND_IN);
  return root;
}

describe('the hook itself', () => {
  it("runs the fast tier with Talos's own build in Talos, and blocks a push it fails", async () => {
    const root = await talosClone();
    await writeFile(join(root, 'exit.txt'), '1');
    expect(await push(root, LINUX, 'HEAD:refs/heads/work')).toBe(1);
    expect(await ran(root)).toEqual(['check --tiers commit dev=1']);
    await writeFile(join(root, 'exit.txt'), '0');
    expect(await push(root, LINUX, 'HEAD:refs/heads/work')).toBe(0);
    await writeFile(join(root, 'exit.txt'), '1');
    expect(await push(root, LINUX, ':refs/heads/work')).toBe(0);
    sh(root, 'tag', 'v1');
    expect(await push(root, LINUX, 'refs/tags/v1')).toBe(0);
    expect(await ran(root)).toHaveLength(2);
  });

  it("leaves Talos's own unit tests out on Windows, and only there", async () => {
    const root = await talosClone();
    await writeFile(join(root, 'exit.txt'), '0');
    expect(await push(root, { OS: 'Windows_NT' }, 'HEAD:refs/heads/work')).toBe(0);
    const windowsTier = PACKS.flatMap((pack) => pack.checks)
      .filter((c) => c.tier === 'commit' && c.scope === 'component' && c.langs?.includes('ts'))
      .map((c) => c.id)
      .filter((id) => id !== 'ts/tests');
    expect(await ran(root)).toEqual([`check --tiers commit --only ${windowsTier.join(',')} dev=1`]);
  });

  it('runs the talos on PATH in a governed repository, and blocks on an engine error', async () => {
    const root = await hooked({ 'README.md': '# demo\n' });
    const bin = join(root, '..', 'bin');
    await mkdir(bin, { recursive: true });
    const script = join(bin, 'talos.mjs').replaceAll('\\', '/');
    await writeFile(script, STAND_IN);
    await writeFile(join(bin, 'talos'), `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
    await writeFile(join(root, 'exit.txt'), '2');
    const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    const path = `${bin}${delimiter}${process.env[key] ?? ''}`;
    // The hook must not pass a TALOS_DEV of its own; the one this test runs under is cleared.
    const env = { [key]: path, TALOS_DEV: '', OS: 'Windows_NT' };
    expect(await push(root, env, 'HEAD:refs/heads/work')).toBe(1);
    expect(await ran(root)).toEqual(['check --tiers commit dev=']);
  });

  it('runs the fast tier in a linked worktree without the GIT_DIR git exports there', async () => {
    const root = await hooked({ 'README.md': '# demo\n' });
    const bin = join(root, '..', 'bin');
    await mkdir(bin, { recursive: true });
    const script = join(bin, 'talos.mjs').replaceAll('\\', '/');
    await writeFile(
      script,
      "import { appendFileSync } from 'node:fs';\nappendFileSync('ran.txt', `dir=${process.env.GIT_DIR ?? ''}\\n`);\n",
    );
    await writeFile(join(bin, 'talos'), `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
    const linked = join(root, '..', 'linked');
    sh(root, 'worktree', 'add', '--quiet', linked);
    const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    const path = `${bin}${delimiter}${process.env[key] ?? ''}`;
    expect(await push(linked, { [key]: path }, 'HEAD:refs/heads/linked')).toBe(0);
    expect(await ran(linked)).toEqual(['dir=']);
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Io, UsageError } from './io.js';
import { currentOs, run, tiersOf } from './run.js';
import { parseRunResult, type RunResult } from '../core/result.js';
import { exec } from '../exec/exec.js';
import { type Git, git } from '../repo/git.js';

const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

const CONFIG = 'name: Notes\nprefix: NO\ndocs: { glossary: GLOSSARY.md }\n';
const GLOSSARY = '# Glossary\n\n**Note**\nOne dated page of text.\nAvoid: memo\n';

type Clone = { readonly repo: Git; readonly base: string; readonly head: string };

/** A base commit, and a head that says, on its third line, a word the glossary avoids. */
async function clone(): Promise<Clone> {
  const cwd = await mkdtemp(join(tmpdir(), 'talos-run-'));
  const repo = git(exec, cwd);
  const commit = async (files: Readonly<Record<string, string>>): Promise<string> => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
    await repo.run(['add', '-A']);
    await repo.run([...COMMIT, 'commit', '-q', '-m', '[NO-1]: Write']);
    return (await repo.run(['rev-parse', 'HEAD'])).trim();
  };
  await repo.run(['init', '-q']);
  const base = await commit({
    'talos.yml': CONFIG,
    'GLOSSARY.md': GLOSSARY,
    'README.md': '# Notes\n',
  });
  const head = await commit({ 'README.md': '# Notes\n\nEach memo is a page.\n' });
  return { repo, base, head };
}

function ioAt(cwd: string): Io & { text: () => string } {
  const out: string[] = [];
  return { cwd, env: {}, out: (t) => out.push(t), err: () => undefined, text: () => out.join('') };
}

const GLOSSARY_ONLY = ['--os', 'linux', '--only', 'docs/glossary'];

function glossaryOutcome(result: RunResult): RunResult['outcomes'][number] | undefined {
  return result.outcomes.find((o) => o.check === 'docs/glossary');
}

describe('talos run', () => {
  it('runs the checks at the checkout and prints its run as JSON', async () => {
    const { repo, head } = await clone();
    const io = ioAt(repo.root);
    expect(await run(GLOSSARY_ONLY, io)).toBe(0);
    const result = parseRunResult(io.text());
    expect(result).toMatchObject({ sha: head, os: 'linux', tiers: ['commit', 'head'] });
    expect(glossaryOutcome(result)?.findings.map((f) => [f.rule, f.location?.line])).toEqual([
      ['glossary/avoid', 3],
    ]);
  });

  it('writes the run to --out, as one side of a comparison over --range', async () => {
    const { repo, base, head } = await clone();
    const out = join(repo.root, '..', `${head}.json`);
    const args = [
      ...GLOSSARY_ONLY,
      '--tiers',
      'head',
      '--range',
      `${base}..${head}`,
      '--side',
      'head',
      '--out',
      out,
    ];
    const io = ioAt(repo.root);
    expect(await run(args, io)).toBe(0);
    expect(io.text()).toBe('');
    const result = parseRunResult(await readFile(out, 'utf8'));
    expect(result.tiers).toEqual(['head']);
    expect(glossaryOutcome(result)?.status).toBe('findings');
  });

  it('judges a checkout without a talos.yml by the one --config-from names', async () => {
    const { repo, head } = await clone();
    await rm(join(repo.root, 'talos.yml'));
    const io = ioAt(repo.root);
    expect(await run([...GLOSSARY_ONLY, '--config-from', head], io)).toBe(0);
    expect(glossaryOutcome(parseRunResult(io.text()))?.findings).toHaveLength(1);
  });

  it('refuses an OS or tiers it does not know', async () => {
    const io = ioAt(tmpdir());
    await expect(run(['--os', 'solaris'], io)).rejects.toThrow(UsageError);
    expect(() => tiersOf('commit,nightly')).toThrow(UsageError);
    expect(() => tiersOf('')).toThrow('--tiers takes commit,head');
    expect(tiersOf('head,commit')).toEqual(['head', 'commit']);
  });

  it('names the OS the way talos.yml does', () => {
    expect(currentOs('win32')).toBe('windows');
    expect(currentOs('darwin')).toBe('macos');
    expect(currentOs('linux')).toBe('linux');
  });
});

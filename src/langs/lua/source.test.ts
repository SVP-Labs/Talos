import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LUA_VERSION } from './devtools.js';
import { fetchSource, LUA_SOURCE, type LuaSource, sourceCurlArgs } from './source.js';
import { EngineError } from '../../core/check.js';
import type { Exec, ExecResult } from '../../exec/exec.js';

const TARBALL = 'lua source\n';

const SOURCE: LuaSource = {
  file: 'lua-5.4.9.tar.gz',
  sha256: createHash('sha256').update(TARBALL).digest('hex'),
  urls: ['https://lua.example/lua-5.4.9.tar.gz'],
};

type Serve = (url: string) => { readonly body?: string; readonly result: ExecResult };

/** Plays curl: answers each URL as `serve` says, writing the body where `--output` says. */
function curl(serve: Serve): { exec: Exec; urls: string[] } {
  const urls: string[] = [];
  const exec: Exec = async (command, args) => {
    expect(command).toBe('curl');
    const url = args.at(-1) ?? '';
    urls.push(url);
    const { body, result } = serve(url);
    const output = args[args.indexOf('--output') + 1];
    if (body !== undefined && output !== undefined) await writeFile(output, body);
    return result;
  };
  return { exec, urls };
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

describe('LUA_SOURCE', () => {
  it("is the tarball of Talos's Lua, from lua.org", () => {
    expect(LUA_SOURCE.file).toBe(`lua-${LUA_VERSION}.tar.gz`);
    expect(LUA_SOURCE.urls[0]).toBe(`https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz`);
    expect(LUA_SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sourceCurlArgs', () => {
  it('retries any error, with time to connect and to finish, over https only', () => {
    const args = sourceCurlArgs('https://lua.example/x.tar.gz', '/work/out');
    const value = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(value('--retry')).toBe('4');
    expect(value('--retry-delay')).toBe('10');
    expect(value('--connect-timeout')).toBe('30');
    expect(value('--max-time')).toBe('300');
    expect(args).toContain('--retry-all-errors');
    expect(args).toContain('--fail');
    expect(value('--proto')).toBe('=https');
    expect(value('--proto-redir')).toBe('=https');
    expect(args.slice(-3)).toEqual(['--output', '/work/out', 'https://lua.example/x.tar.gz']);
  });
});

describe('fetchSource', () => {
  it('puts the tarball in the directory under its own name when its sha256 matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lua-source-'));
    const { exec } = curl(() => ({ body: TARBALL, result: OK }));
    const file = await fetchSource(exec, SOURCE, dir);
    expect(file).toBe(join(dir, SOURCE.file));
    expect(await readFile(file, 'utf8')).toBe(TARBALL);
    expect(await readdir(dir)).toEqual([SOURCE.file]);
  });

  it('refuses a tarball whose sha256 is not the pinned one, and keeps nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lua-source-'));
    const { exec } = curl(() => ({ body: 'tampered\n', result: OK }));
    const fetching = fetchSource(exec, SOURCE, dir);
    await expect(fetching).rejects.toThrow(EngineError);
    await expect(fetching).rejects.toThrow(`not the pinned ${SOURCE.sha256}`);
    expect(await readdir(dir)).toEqual([]);
  });

  it('says what curl printed when the download fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lua-source-'));
    const timedOut = { code: 28, stdout: '', stderr: 'curl: (28) Connection timed out' };
    const { exec } = curl(() => ({ result: timedOut }));
    await expect(fetchSource(exec, SOURCE, dir)).rejects.toThrow(
      'cannot download lua-5.4.9.tar.gz:\nhttps://lua.example/lua-5.4.9.tar.gz: curl exited 28: ' +
        'curl: (28) Connection timed out',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('turns a curl that cannot run into an engine error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lua-source-'));
    const exec: Exec = () => Promise.reject(new Error('spawn curl ENOENT'));
    await expect(fetchSource(exec, SOURCE, dir)).rejects.toThrow(/curl ENOENT/);
  });
});

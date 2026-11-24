import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LUA_VERSION } from './devtools.js';
import {
  cachedSource,
  fetchSource,
  LUA_SOURCE,
  type LuaSource,
  sourceCurlArgs,
  toolCache,
} from './source.js';
import { EngineError } from '../../core/check.js';
import { silentLogger } from '../../core/log.js';
import type { Exec, ExecResult } from '../../exec/exec.js';

const TARBALL = 'lua source\n';

const SOURCE: LuaSource = {
  version: '5.4.9',
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

  it("falls back to Fedora's lookaside cache, never to hererocks's PUC-Rio mirror", () => {
    expect(LUA_SOURCE.urls).toHaveLength(2);
    expect(LUA_SOURCE.urls[1]).toMatch(
      new RegExp(
        `^https://src\\.fedoraproject\\.org/repo/pkgs/lua/lua-${LUA_VERSION}\\.tar\\.gz/sha512/` +
          `[0-9a-f]{128}/lua-${LUA_VERSION}\\.tar\\.gz$`,
      ),
    );
    expect(LUA_SOURCE.urls.filter((url) => url.includes('puc-rio.br'))).toEqual([]);
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

  it('tries the next URL when one fails or serves another file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lua-source-'));
    const urls = ['https://a.example/l.tar.gz', 'https://b.example/l.tar.gz'];
    const three = { ...SOURCE, urls: [...urls, 'https://c.example/l.tar.gz'] };
    const served = curl((url) => {
      if (url === urls[0]) return { result: { code: 22, stdout: '', stderr: 'HTTP 404' } };
      if (url === urls[1]) return { body: 'tampered\n', result: OK };
      return { body: TARBALL, result: OK };
    });
    const file = await fetchSource(served.exec, three, dir);
    expect(await readFile(file, 'utf8')).toBe(TARBALL);
    expect(served.urls).toEqual(three.urls);
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

describe('toolCache', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is tools in Talos's cache directory", () => {
    vi.stubEnv('TALOS_CACHE', '/work/cache');
    expect(toolCache()).toBe(join('/work/cache', 'tools'));
  });
});

describe('cachedSource', () => {
  it('keeps the verified tarball under lua-source/<version> and reuses it', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'lua-cache-'));
    const { exec, urls } = curl(() => ({ body: TARBALL, result: OK }));
    const ctx = { exec, log: silentLogger };
    const first = await cachedSource(ctx, SOURCE, cache);
    const again = await cachedSource(ctx, SOURCE, cache);
    expect(first).toBe(join(cache, 'lua-source', '5.4.9', SOURCE.file));
    expect(again).toBe(first);
    expect(await readFile(first, 'utf8')).toBe(TARBALL);
    expect(urls).toEqual(SOURCE.urls);
  });

  it('fetches again over an entry stamped with another sha256', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'lua-cache-'));
    const old = { ...SOURCE, sha256: createHash('sha256').update('old\n').digest('hex') };
    const served = { body: 'old\n', result: OK };
    await cachedSource({ exec: curl(() => served).exec, log: silentLogger }, old, cache);
    const { exec, urls } = curl(() => ({ body: TARBALL, result: OK }));
    const file = await cachedSource({ exec, log: silentLogger }, SOURCE, cache);
    expect(await readFile(file, 'utf8')).toBe(TARBALL);
    expect(urls).toHaveLength(1);
  });

  it('leaves no entry behind when the download fails', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'lua-cache-'));
    const { exec } = curl(() => ({ result: { code: 22, stdout: '', stderr: 'HTTP 404' } }));
    await expect(cachedSource({ exec, log: silentLogger }, SOURCE, cache)).rejects.toThrow(
      EngineError,
    );
    expect(await readdir(join(cache, 'lua-source'))).toEqual([]);
  });
});

import { createHash } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LUA_VERSION } from './devtools.js';
import { EngineError } from '../../core/check.js';
import type { InstallContext } from '../../core/pack.js';
import type { Exec, ExecResult } from '../../exec/exec.js';
import { ensureDir } from '../../tools/store.js';
import { cacheRoot } from '../../version/cache.js';

/**
 * Where Lua's source tarball comes from, tried in order, and the sha256 every copy of it must
 * have. Each URL is one that serves the file.
 */
export type LuaSource = {
  readonly version: string;
  readonly file: string;
  readonly sha256: string;
  readonly urls: readonly string[];
};

export const LUA_SOURCE: LuaSource = {
  version: LUA_VERSION,
  file: `lua-${LUA_VERSION}.tar.gz`,
  sha256: '2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6',
  urls: [
    `https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz`,
    // Fedora's lookaside cache is addressed by the file's sha512, so it can only serve this file.
    `https://src.fedoraproject.org/repo/pkgs/lua/lua-${LUA_VERSION}.tar.gz/sha512/` +
      'b112bd3f0d47043568ef52928853ef692554378a5e368d420b589babf606a82c' +
      'e05fca781f5401c3565171800b39322141ee500e53e813d1a4ccc5d3a05879b1' +
      `/lua-${LUA_VERSION}.tar.gz`,
  ],
};

/** Covers curl's every attempt at one URL, with the waits between them. */
const DOWNLOAD_TIMEOUT = 30 * 60 * 1000;

/**
 * lua.org can take tens of seconds to answer or drop a connection, then serve the file on the
 * next try: each attempt gets 30 s to connect and 5 minutes in all, and any error is retried.
 */
export function sourceCurlArgs(url: string, output: string): string[] {
  return [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--connect-timeout',
    '30',
    '--max-time',
    '300',
    '--retry',
    '4',
    '--retry-delay',
    '10',
    '--retry-all-errors',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--output',
    output,
    url,
  ];
}

/** The file's sha256, or undefined when there is no file to read. */
async function sha256Of(file: string): Promise<string | undefined> {
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return undefined;
  }
  return createHash('sha256').update(data).digest('hex');
}

function last(result: ExecResult): string {
  return (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
}

/** Downloads one URL to `file`; the reason it failed, or undefined. */
async function attempt(
  exec: Exec,
  source: LuaSource,
  url: string,
  file: string,
): Promise<string | undefined> {
  let result: ExecResult;
  try {
    const options = { cwd: dirname(file), timeoutMs: DOWNLOAD_TIMEOUT };
    result = await exec('curl', sourceCurlArgs(url, file), options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (result.code !== 0) return `curl exited ${result.code}: ${last(result)}`;
  const actual = await sha256Of(file);
  if (actual === undefined) return 'curl exited 0 but wrote no file';
  if (actual !== source.sha256) return `sha256 ${actual}, not the pinned ${source.sha256}`;
  return undefined;
}

/**
 * Puts the source tarball in `dir` under its own name, from the first URL that serves it with
 * the pinned sha256. A file that fails the check is never kept.
 */
export async function fetchSource(exec: Exec, source: LuaSource, dir: string): Promise<string> {
  const partial = join(dir, '.download');
  const failures: string[] = [];
  for (const url of source.urls) {
    const failure = await attempt(exec, source, url, partial);
    if (failure === undefined) {
      const target = join(dir, source.file);
      await rename(partial, target);
      return target;
    }
    await rm(partial, { force: true });
    failures.push(`${url}: ${failure}`);
  }
  throw new EngineError(`cannot download ${source.file}:\n${failures.join('\n')}`);
}

/** Talos's tool cache: `tools` in `TALOS_CACHE`, else in the user's cache directory. */
export function toolCache(): string {
  return join(cacheRoot(process.env), 'tools');
}

/**
 * The verified tarball in the tool cache, under `lua-source/<version>`, fetched only when the
 * cache has no complete copy with the pinned sha256.
 */
export async function cachedSource(
  ctx: Pick<InstallContext, 'exec' | 'log'>,
  source: LuaSource,
  cache: string,
): Promise<string> {
  const dir = join(cache, 'lua-source', source.version);
  await ensureDir(dir, source.sha256, async (work) => {
    ctx.log.info(`downloading Lua ${source.version}'s source`);
    await fetchSource(ctx.exec, source, work);
  });
  return join(dir, source.file);
}

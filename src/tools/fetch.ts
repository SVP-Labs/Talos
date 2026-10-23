import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import type { Download, FileTool } from './lockfile.js';
import { EngineError } from '../core/check.js';
import type { Exec, ExecResult } from '../exec/exec.js';

const DOWNLOAD_TIMEOUT = 15 * 60 * 1000;

export type Format = 'tar' | 'zip' | 'file';

/** How a download is unpacked: by its kind, then by the URL's extension. */
export function formatOf(kind: FileTool['kind'], url: string): Format {
  if (kind === 'binary') return 'file';
  if (kind === 'psgallery') return 'zip';
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.zip')) return 'zip';
  if (/\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?)$/.test(path)) return 'tar';
  throw new EngineError(`tools.lock: no way to unpack ${url}`);
}

/**
 * curl follows redirects (release downloads redirect to a CDN) over https only, retries
 * transient failures, and honours HTTPS_PROXY; Windows ships it as curl.exe.
 */
export function curlArgs(url: string, output: string): string[] {
  return [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--retry',
    '3',
    '--proto',
    '=https,file',
    '--proto-redir',
    '=https',
    '--output',
    output,
    url,
  ];
}

export type Unpack = { readonly command: string; readonly args: readonly string[] };

/**
 * The program that unpacks an archive. On Windows it is the system's own bsdtar, which reads
 * zip files too; a GNU tar earlier on PATH (Git's) would take `C:\…` for a remote host.
 */
export function unpackCommand(
  format: 'tar' | 'zip',
  archive: string,
  into: string,
  host: { readonly platform: NodeJS.Platform; readonly systemRoot?: string | undefined },
): Unpack {
  if (host.platform === 'win32') {
    const tar = win32.join(host.systemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    return { command: tar, args: ['-xf', archive, '-C', into] };
  }
  if (format === 'zip') return { command: 'unzip', args: ['-q', '-o', archive, '-d', into] };
  return { command: 'tar', args: ['-xf', archive, '-C', into] };
}

async function sha256Of(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export type FetchContext = {
  readonly exec: Exec;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
};

function last(result: ExecResult): string {
  return (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
}

async function run(
  ctx: FetchContext,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  let result: ExecResult;
  try {
    result = await ctx.exec(command, args, { cwd, timeoutMs: DOWNLOAD_TIMEOUT });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`${command} is needed to fetch Talos's tools: ${reason}`);
  }
  if (result.code !== 0) {
    throw new EngineError(`${command} ${args.join(' ')} exited ${result.code}: ${last(result)}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type Fetch = {
  readonly name: string;
  readonly tool: FileTool;
  readonly download: Download;
  /** An empty directory the tool is unpacked into. */
  readonly work: string;
};

/**
 * Downloads a tool into `work`, refuses it unless its sha256 is the one `tools.lock` pins,
 * and unpacks it there; its executable is marked executable.
 */
export async function fetchInto(ctx: FetchContext, job: Fetch): Promise<void> {
  const { name, tool, download, work } = job;
  const file = join(work, '.download');
  await run(ctx, 'curl', curlArgs(download.url, file), work);
  const actual = await sha256Of(file);
  if (actual !== download.sha256) {
    await rm(file, { force: true });
    throw new EngineError(
      `refusing ${name} ${tool.version}: ${download.url} has sha256 ${actual}, ` +
        `but tools.lock pins ${download.sha256}`,
    );
  }
  const target = join(work, download.path);
  const format = formatOf(tool.kind, download.url);
  if (format === 'file') {
    await mkdir(dirname(target), { recursive: true });
    await rename(file, target);
  } else {
    const unpack = unpackCommand(format, file, work, {
      platform: ctx.platform,
      systemRoot: ctx.env.SystemRoot,
    });
    await run(ctx, unpack.command, unpack.args, work);
    await rm(file, { force: true });
  }
  if (!(await exists(target))) {
    throw new EngineError(`${name} ${tool.version} from ${download.url} has no ${download.path}`);
  }
  if (tool.kind !== 'psgallery') await chmod(target, 0o755);
}

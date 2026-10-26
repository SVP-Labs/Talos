import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FetchContext, fetchInto } from './fetch.js';
import {
  downloadFor,
  type FileTool,
  lockedTool,
  parseLock,
  type PypiTool,
  type ToolsLock,
} from './lockfile.js';
import { installArgs, pypiStamp, venvArgs, venvProgram } from './pypi.js';
import { ensureDir } from './store.js';
import type { Tools } from './tools.js';
import { EngineError } from '../core/check.js';
import type { Logger } from '../core/log.js';
import type { Exec } from '../exec/exec.js';
import { cacheRoot } from '../version/cache.js';

const INSTALL_TIMEOUT = 30 * 60 * 1000;

export type ToolsOptions = {
  /** Defaults to the `tools.lock` shipped beside Talos's `package.json`. */
  readonly lockFile?: string;
  /** Defaults to `tools` in Talos's cache directory. */
  readonly cacheDir?: string;
  /** The `tools.lock` platform key; defaults to this machine's. */
  readonly platform?: string;
};

/** `tools.lock` sits at the package's root, two levels above this module in `src` and `dist`. */
function shippedLock(): string {
  return fileURLToPath(new URL('../../tools.lock', import.meta.url));
}

function loadLock(file: string): ToolsLock {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new EngineError(`cannot read ${file}`);
  }
  return parseLock(text, file);
}

type Session = FetchContext & {
  readonly log: Logger;
  readonly lockFile: string;
  readonly cache: string;
  /** The `tools.lock` platform key. */
  readonly key: string;
  readonly lock: () => ToolsLock;
  readonly path: (name: string) => Promise<string>;
};

async function fileTool(session: Session, name: string, tool: FileTool): Promise<string> {
  const download = downloadFor(tool, name, session.key);
  const dir = join(session.cache, name, tool.version);
  await ensureDir(dir, download.sha256, async (work) => {
    session.log.info(`downloading ${name} ${tool.version}`);
    await fetchInto(session, { name, tool, download, work });
  });
  return join(dir, download.path);
}

async function uvStep(session: Session, args: readonly string[], cwd: string): Promise<void> {
  const uv = await session.path('uv');
  const env = { UV_PYTHON_INSTALL_DIR: join(session.cache, 'python') };
  const result = await session.exec(uv, args, { cwd, env, timeoutMs: INSTALL_TIMEOUT });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-10).join('\n');
    throw new EngineError(`uv ${args.slice(0, 2).join(' ')} failed: ${detail}`);
  }
}

async function pypiTool(session: Session, name: string, tool: PypiTool): Promise<string> {
  const requirements = join(dirname(session.lockFile), tool.requirements);
  let text: string;
  try {
    text = await readFile(requirements, 'utf8');
  } catch {
    throw new EngineError(`cannot read ${requirements}, which tools.lock names for ${name}`);
  }
  const python = session.lock().runtimes.python;
  const dir = join(session.cache, name, tool.version);
  await ensureDir(dir, pypiStamp(python, text), async (work) => {
    session.log.info(`installing ${name} ${tool.version}`);
    const venv = join(work, 'venv');
    await uvStep(session, venvArgs(python, venv), work);
    await uvStep(session, installArgs(venv, requirements, session.platform), work);
  });
  return venvProgram(join(dir, 'venv'), tool.bin, session.platform);
}

async function resolveTool(session: Session, name: string): Promise<string> {
  const tool = lockedTool(session.lock(), name);
  return tool.kind === 'pypi' ? pypiTool(session, name, tool) : fileTool(session, name, tool);
}

/**
 * Tools from `tools.lock`: each is fetched into Talos's cache on first use, under
 * `<name>/<version>`, and refused unless its sha256 is the one the lock pins. One process
 * fetches a tool once however many checks ask for it at the same time.
 */
export function createTools(exec: Exec, log: Logger, options: ToolsOptions = {}): Tools {
  const lockFile = options.lockFile ?? shippedLock();
  let lock: ToolsLock | undefined;
  const pending = new Map<string, Promise<string>>();
  const session: Session = {
    exec,
    log,
    env: process.env,
    platform: process.platform,
    lockFile,
    cache: options.cacheDir ?? join(cacheRoot(process.env), 'tools'),
    key: options.platform ?? `${process.platform}-${process.arch}`,
    lock: () => (lock ??= loadLock(lockFile)),
    path: (name) => {
      let found = pending.get(name);
      if (found === undefined) {
        found = resolveTool(session, name);
        pending.set(name, found);
        found.catch(() => pending.delete(name));
      }
      return found;
    },
  };
  return {
    path: (name) => session.path(name),
    version: (name) => lockedTool(session.lock(), name).version,
  };
}

import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createTools } from './lock.js';
import { venvProgram } from './pypi.js';
import { STAMP } from './store.js';
import { EngineError } from '../core/check.js';
import { silentLogger } from '../core/log.js';
import { type Exec, exec } from '../exec/exec.js';

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

type Fixture = { dir: string; archive: string; archiveSha: string; script: string };

/** A zip archive of uncompressed entries, so the test needs no zip program. */
function storedZip(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const fileName = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0o100755 * 0x10000, 38);
  const centralOffset = local.length + fileName.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

/** A gzipped ustar archive of one file, so the test needs no tar program. */
function tarGz(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const header = Buffer.alloc(512);
  const field = (value: string, offset: number): void => {
    header.write(value, offset, 'ascii');
  };
  field(name, 0);
  field('0000755\0', 100);
  field('0000000\0', 108);
  field('0000000\0', 116);
  field(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  field('00000000000\0', 136);
  field('        ', 148);
  field('0', 156);
  field('ustar\0', 257);
  field('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  field(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)]));
}

/** A tar.gz holding `pkg/tool`, a zip holding `tool.sh`, and a single file, all local. */
async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'talos-tools-'));
  const script = '#!/bin/sh\necho tool\n';
  await writeFile(join(dir, 'single.py'), 'print("single")\n');
  const archive = join(dir, 'tool.tar.gz');
  await writeFile(archive, tarGz('pkg/tool', script));
  await writeFile(join(dir, 'tool.zip'), storedZip('tool.sh', script));
  return { dir, archive, archiveSha: sha(await readFile(archive)), script };
}

const url = (path: string): string => pathToFileURL(path).href;

async function writeLock(f: Fixture, tools: Record<string, unknown>): Promise<string> {
  const lockFile = join(f.dir, 'tools.lock');
  await writeFile(lockFile, JSON.stringify({ runtimes: { python: '3.13.17' }, tools }));
  return lockFile;
}

function archiveTool(f: Fixture, sha256 = f.archiveSha): unknown {
  return {
    version: '1.2.3',
    kind: 'archive',
    platforms: { any: { url: url(f.archive), sha256, path: 'pkg/tool' } },
  };
}

/** Counts how often each program ran. */
function counting(): { exec: Exec; runs: Map<string, number> } {
  const runs = new Map<string, number>();
  return {
    runs,
    exec: (command, args, options) => {
      runs.set(command, (runs.get(command) ?? 0) + 1);
      return exec(command, args, options);
    },
  };
}

describe('createTools', () => {
  it('downloads, verifies and unpacks a tool into <name>/<version>, executable', async () => {
    const f = await fixture();
    const lockFile = await writeLock(f, { demo: archiveTool(f) });
    const cacheDir = join(f.dir, 'cache');
    const tools = createTools(exec, silentLogger, { lockFile, cacheDir });
    const path = await tools.path('demo');
    expect(path).toBe(join(cacheDir, 'demo', '1.2.3', 'pkg', 'tool'));
    expect(await readFile(path, 'utf8')).toBe(f.script);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o111).not.toBe(0);
    expect(await readFile(join(cacheDir, 'demo', '1.2.3', STAMP), 'utf8')).toBe(f.archiveSha);
    expect(tools.version('demo')).toBe('1.2.3');
  });

  it('serves a cached tool without downloading again', async () => {
    const f = await fixture();
    const lockFile = await writeLock(f, { demo: archiveTool(f) });
    const cacheDir = join(f.dir, 'cache');
    await createTools(exec, silentLogger, { lockFile, cacheDir }).path('demo');
    await rm(f.archive);
    const second = counting();
    const path = await createTools(second.exec, silentLogger, { lockFile, cacheDir }).path('demo');
    expect(await exists(path)).toBe(true);
    expect(second.runs.size).toBe(0);
  });

  it('fetches once for checks asking at the same time', async () => {
    const f = await fixture();
    const lockFile = await writeLock(f, { demo: archiveTool(f) });
    const counted = counting();
    const tools = createTools(counted.exec, silentLogger, {
      lockFile,
      cacheDir: join(f.dir, 'cache'),
    });
    const paths = await Promise.all([tools.path('demo'), tools.path('demo'), tools.path('demo')]);
    expect(new Set(paths).size).toBe(1);
    expect(counted.runs.get('curl')).toBe(1);
  });

  it('refuses a download whose sha256 is not the pinned one, and caches nothing', async () => {
    const f = await fixture();
    const lockFile = await writeLock(f, { demo: archiveTool(f, 'a'.repeat(64)) });
    const cacheDir = join(f.dir, 'cache');
    const tools = createTools(exec, silentLogger, { lockFile, cacheDir });
    await expect(tools.path('demo')).rejects.toThrow(EngineError);
    await expect(tools.path('demo')).rejects.toThrow(/refusing demo 1\.2\.3: .* has sha256 /);
    expect(await exists(join(cacheDir, 'demo', '1.2.3'))).toBe(false);
  });

  it('replaces a cached copy of another download of the same version', async () => {
    const f = await fixture();
    const cacheDir = join(f.dir, 'cache');
    const stale = join(cacheDir, 'demo', '1.2.3');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, STAMP), 'b'.repeat(64));
    const lockFile = await writeLock(f, { demo: archiveTool(f) });
    const path = await createTools(exec, silentLogger, { lockFile, cacheDir }).path('demo');
    expect(await readFile(path, 'utf8')).toBe(f.script);
  });

  it('saves a single-file tool under its path and unpacks zip files', async () => {
    const f = await fixture();
    const zip = join(f.dir, 'tool.zip');
    const single = join(f.dir, 'single.py');
    const lockFile = await writeLock(f, {
      single: {
        version: '0.1.0',
        kind: 'binary',
        platforms: {
          any: { url: url(single), sha256: sha(await readFile(single)), path: 'single.py' },
        },
      },
      zipped: {
        version: '2.0.0',
        kind: 'archive',
        platforms: { any: { url: url(zip), sha256: sha(await readFile(zip)), path: 'tool.sh' } },
      },
    });
    const tools = createTools(exec, silentLogger, { lockFile, cacheDir: join(f.dir, 'cache') });
    expect(await readFile(await tools.path('single'), 'utf8')).toBe('print("single")\n');
    expect(await readFile(await tools.path('zipped'), 'utf8')).toBe(f.script);
  });

  it('picks the download for the platform, and fails for one the lock lacks', async () => {
    const f = await fixture();
    const lockFile = await writeLock(f, {
      demo: {
        version: '1.2.3',
        kind: 'archive',
        platforms: {
          'darwin-arm64': { url: url(f.archive), sha256: f.archiveSha, path: 'pkg/tool' },
        },
      },
    });
    const cacheDir = join(f.dir, 'cache');
    const mac = createTools(exec, silentLogger, { lockFile, cacheDir, platform: 'darwin-arm64' });
    expect(await mac.path('demo')).toBe(join(cacheDir, 'demo', '1.2.3', 'pkg', 'tool'));
    const windows = createTools(exec, silentLogger, { lockFile, cacheDir, platform: 'win32-x64' });
    await expect(windows.path('demo')).rejects.toThrow(
      'tools.lock has no demo 1.2.3 for win32-x64',
    );
  });

  it('reports a tool the lock lacks, and an unreadable lock, as engine errors', async () => {
    const f = await fixture();
    const lockFile = await writeLock(f, { demo: archiveTool(f) });
    const tools = createTools(exec, silentLogger, { lockFile, cacheDir: join(f.dir, 'cache') });
    expect(() => tools.version('gitleaks')).toThrow('gitleaks is not in tools.lock');
    await expect(tools.path('gitleaks')).rejects.toThrow(EngineError);
    const missing = createTools(exec, silentLogger, { lockFile: join(f.dir, 'nothing.lock') });
    expect(() => missing.version('demo')).toThrow(/cannot read/);
  });

  it('installs a Python tool from hashed requirements into a cached environment', async () => {
    const f = await fixture();
    const uv = join(f.dir, 'uv');
    await writeFile(uv, '#!/bin/sh\n');
    await mkdir(join(f.dir, 'tools'));
    await writeFile(join(f.dir, 'tools', 'demo.txt'), 'demo==1.0 --hash=sha256:00\n');
    const lockFile = await writeLock(f, {
      uv: {
        version: '0.1.0',
        kind: 'binary',
        platforms: { any: { url: url(uv), sha256: sha(await readFile(uv)), path: 'uv' } },
      },
      demo: { version: '1.0', kind: 'pypi', requirements: 'tools/demo.txt', bin: 'demo' },
    });
    const calls: string[][] = [];
    const fake: Exec = async (command, args, options) => {
      if (!command.endsWith('uv')) return exec(command, args, options);
      calls.push([...args]);
      const venv = args[0] === 'venv' ? args.at(-1) : undefined;
      if (venv !== undefined) {
        const program = venvProgram(venv, 'demo', process.platform);
        await mkdir(join(program, '..'), { recursive: true });
        await writeFile(program, '');
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const cacheDir = join(f.dir, 'cache');
    const path = await createTools(fake, silentLogger, { lockFile, cacheDir }).path('demo');
    expect(path).toBe(venvProgram(join(cacheDir, 'demo', '1.0', 'venv'), 'demo', process.platform));
    expect(await exists(path)).toBe(true);
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ['venv', '--no-config'],
      ['pip', 'install'],
    ]);
    expect(calls[0]).toContain('3.13.17');
    expect(calls[1]).toContain(join(f.dir, 'tools', 'demo.txt'));
  });

  it('reports a failed Python install with what uv said', async () => {
    const f = await fixture();
    const uv = join(f.dir, 'uv');
    await writeFile(uv, '#!/bin/sh\n');
    await mkdir(join(f.dir, 'tools'));
    await writeFile(join(f.dir, 'tools', 'demo.txt'), 'demo==1.0\n');
    const lockFile = await writeLock(f, {
      uv: {
        version: '0.1.0',
        kind: 'binary',
        platforms: { any: { url: url(uv), sha256: sha(await readFile(uv)), path: 'uv' } },
      },
      demo: { version: '1.0', kind: 'pypi', requirements: 'tools/demo.txt', bin: 'demo' },
      lost: { version: '1.0', kind: 'pypi', requirements: 'tools/lost.txt', bin: 'lost' },
    });
    const fake: Exec = (command, args, options) =>
      command.endsWith('uv')
        ? Promise.resolve({ code: 2, stdout: '', stderr: 'error: no hash for demo' })
        : exec(command, args, options);
    const tools = createTools(fake, silentLogger, { lockFile, cacheDir: join(f.dir, 'cache') });
    await expect(tools.path('demo')).rejects.toThrow('uv venv --no-config failed: error: no hash');
    await expect(tools.path('lost')).rejects.toThrow(/cannot read .*lost\.txt/);
  });
});

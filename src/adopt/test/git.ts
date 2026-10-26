import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../../exec/exec.js';

/**
 * Runs a program without writing to its stdin. The shared `exec` ends stdin after spawning, which
 * raises an uncaught EPIPE when a quick command (`git rev-parse --quiet`) has already exited.
 */
export const quietExec: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd: options.cwd }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(new Error(error.message));
        return;
      }
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr });
    });
  });

/** Runs a program from PATH, as the engine's own `exec` does, and returns what it printed. */
function runSync(program: string, args: readonly string[], cwd: string): string {
  return execFileSync(program, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

export function sh(cwd: string, ...args: string[]): string {
  return runSync('git', args, cwd);
}

/** A clone of a bare origin, with `files` committed on main and pushed. */
export async function clone(
  files: Readonly<Record<string, string>> = { 'package.json': '{}\n' },
): Promise<{ root: string; origin: string }> {
  const base = await mkdtemp(join(tmpdir(), 'talos-adopt-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'work');
  sh(base, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  sh(base, 'clone', '--quiet', origin, root);
  sh(root, 'config', 'user.email', 't@example.com');
  sh(root, 'config', 'user.name', 'T');
  sh(root, 'config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  sh(root, 'add', '.');
  sh(root, 'commit', '--quiet', '-m', 'first');
  sh(root, 'push', '--quiet', 'origin', 'main');
  return { root, origin };
}

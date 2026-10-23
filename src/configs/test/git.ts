import { exec, execOk } from '../../exec/exec.js';
import { tempRepo } from '../../testing/engine.js';

const IDENTITY = [
  '-c',
  'user.name=Talos',
  '-c',
  'user.email=talos@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** Runs git in `root`, returning its output. */
export async function gitIn(root: string, ...args: string[]): Promise<string> {
  return execOk(exec, 'git', [...IDENTITY, ...args], { cwd: root });
}

/** Commits everything in the working tree and returns the commit's SHA. */
export async function commitAll(root: string, subject = '[T-1]: Commit'): Promise<string> {
  await gitIn(root, 'add', '--all');
  await gitIn(root, 'commit', '--quiet', '--allow-empty', '--message', subject);
  return (await gitIn(root, 'rev-parse', 'HEAD')).trim();
}

/** A git repository holding the files, committed once. */
export async function committedRepo(
  files: Readonly<Record<string, string>>,
): Promise<{ readonly root: string; readonly sha: string }> {
  const root = await tempRepo(files);
  await gitIn(root, 'init', '--quiet', '--initial-branch=main');
  return { root, sha: await commitAll(root) };
}

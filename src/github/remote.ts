import { repoFromRemote } from './api.js';
import type { Exec } from '../exec/exec.js';

const NAME = /^[\w.-]+\/[\w.-]+$/;

/** Whether `text` is an `owner/name` GitHub accepts. */
export function isRepoName(text: string): boolean {
  return NAME.test(text);
}

/**
 * The GitHub repository a command acts on: `GITHUB_REPOSITORY` in Actions, else the `origin`
 * remote of the clone at `cwd`; `undefined` when neither names one.
 */
export async function currentRepository(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  exec: Exec,
): Promise<string | undefined> {
  const fromEnv = env.GITHUB_REPOSITORY;
  if (fromEnv !== undefined && isRepoName(fromEnv)) return fromEnv;
  try {
    const result = await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 10_000 });
    if (result.code !== 0) return undefined;
    const repo = repoFromRemote(result.stdout);
    return repo !== undefined && isRepoName(repo) ? repo : undefined;
  } catch {
    return undefined;
  }
}

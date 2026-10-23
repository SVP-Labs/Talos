import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listRunArtifacts } from './actions.js';
import { type GitHub, GitHubError, type GitHubOptions } from './api.js';
import { type Exec, ExecError } from '../exec/exec.js';

/** A binary GET against the API; the client in `api.ts` reads JSON and text only. */
export type Download = (path: string) => Promise<Uint8Array>;

const API = 'https://api.github.com';
const MAX_ARCHIVE = 100 * 1024 * 1024;
const EXTRACT_TIMEOUT = 60_000;

export function downloader(token: string, options: GitHubOptions = {}): Download {
  const baseUrl = options.baseUrl ?? API;
  const doFetch = options.fetch ?? fetch;
  return async (path) => {
    const url = path.startsWith('https://') ? path : `${baseUrl}/${path.replace(/^\//, '')}`;
    if (!url.startsWith(`${baseUrl}/`)) throw new GitHubError('GET artifact: not an API URL', 0);
    const first = await doFetch(url, {
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'svp-labs-talos',
      },
    });
    const location = first.headers.get('location');
    // The archive sits behind a short-lived signed URL on a storage host, which must never see
    // the API token, so the redirect is followed by hand and without headers.
    const response =
      first.status >= 300 && first.status < 400 && location !== null
        ? await doFetch(location)
        : first;
    if (!response.ok) throw new GitHubError(`GET ${path}: ${response.status}`, response.status);
    return new Uint8Array(await response.arrayBuffer());
  };
}

const PLAIN_NAME = /^\w[\w./-]*$/;

function couldNotStart(error: unknown): boolean {
  return error instanceof ExecError && error.message.includes('could not start');
}

/**
 * One file of a zip archive as text, through the system's `unzip`, or `tar` where only that is
 * there (bsdtar, on Windows and macOS, reads zip); `undefined` when the archive lacks it.
 */
export async function extractFile(
  exec: Exec,
  archive: string,
  file: string,
): Promise<string | undefined> {
  if (!PLAIN_NAME.test(file) || file.split('/').includes('..')) {
    throw new TypeError(`not a plain file name inside an archive: ${file}`);
  }
  const options = { cwd: dirname(archive), timeoutMs: EXTRACT_TIMEOUT };
  try {
    const result = await exec('unzip', ['-p', archive, file], options);
    // unzip exits 11 when no member matches.
    if (result.code === 11) return undefined;
    if (result.code === 0) return result.stdout;
    throw new ExecError(`unzip exited ${result.code}`);
  } catch (error) {
    if (!couldNotStart(error)) throw error;
  }
  const result = await exec('tar', ['-xOf', archive, file], options);
  if (result.code === 0) return result.stdout;
  if (/not found/i.test(result.stderr)) return undefined;
  throw new ExecError(`tar exited ${result.code}`);
}

export type ArtifactFile = {
  readonly repo: string;
  readonly runId: number;
  /** The artifact's name, such as `talos-verdict`. */
  readonly artifact: string;
  /** The file inside it, such as `verdict.json`. */
  readonly file: string;
};

/**
 * A file from a workflow run's artifact, downloaded into a temporary directory that is removed
 * afterwards; `undefined` when the run has no such artifact, it expired, or it lacks the file.
 */
export async function readArtifactFile(
  gh: GitHub,
  download: Download,
  exec: Exec,
  wanted: ArtifactFile,
): Promise<string | undefined> {
  const artifacts = await listRunArtifacts(gh, wanted.repo, wanted.runId);
  const artifact = artifacts.find((a) => a.name === wanted.artifact && !a.expired);
  if (artifact === undefined) return undefined;
  if (artifact.size_in_bytes > MAX_ARCHIVE) {
    throw new GitHubError(`artifact ${artifact.name} is over ${MAX_ARCHIVE} bytes`, 413);
  }
  const directory = await mkdtemp(join(tmpdir(), 'talos-artifact-'));
  try {
    const archive = join(directory, 'artifact.zip');
    await writeFile(
      archive,
      await download(`repos/${wanted.repo}/actions/artifacts/${artifact.id}/zip`),
    );
    return await extractFile(exec, archive, wanted.file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

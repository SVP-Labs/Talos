import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export class GitHubError extends Error {
  override readonly name = 'GitHubError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type RequestOptions = {
  readonly body?: unknown;
  readonly accept?: string;
  /** Resolves to `undefined` instead of throwing on 404. */
  readonly allowMissing?: boolean;
};

export type GitHub = {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /** Every page of a list endpoint; `key` names the array in endpoints that wrap it. */
  paginate<T>(path: string, key?: string): Promise<T[]>;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
};

export type GitHubOptions = {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
};

const API = 'https://api.github.com';

function nextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(',')) {
    const [url, rel] = part.split(';').map((s) => s.trim());
    if (rel === 'rel="next"' && url?.startsWith('<') === true) return url.slice(1, -1);
  }
  return undefined;
}

/**
 * A small REST and GraphQL client. Error messages name the method, path and status only, never a
 * response body, so a caller can still decide whether a message may be printed.
 */
export function github(token: string, options: GitHubOptions = {}): GitHub {
  const baseUrl = options.baseUrl ?? API;
  const doFetch = options.fetch ?? fetch;
  const headers = (accept?: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: accept ?? 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'svp-labs-talos',
  });
  const send = async (method: string, url: string, opts: RequestOptions): Promise<Response> => {
    const response = await doFetch(url, {
      method,
      headers: {
        ...headers(opts.accept),
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    return response;
  };
  const request = async <T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> => {
    const url = path.startsWith('https://') ? path : `${baseUrl}/${path.replace(/^\//, '')}`;
    const response = await send(method, url, opts);
    if (response.status === 404 && opts.allowMissing === true) return undefined as T;
    if (!response.ok) {
      throw new GitHubError(`${method} ${path}: ${response.status}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    const type = response.headers.get('content-type') ?? '';
    return (type.includes('json') ? await response.json() : await response.text()) as T;
  };
  const paginate = async <T>(path: string, key?: string): Promise<T[]> => {
    const items: T[] = [];
    const separator = path.includes('?') ? '&' : '?';
    let url: string | undefined = `${baseUrl}/${path.replace(/^\//, '')}${separator}per_page=100`;
    while (url !== undefined) {
      const response = await send('GET', url, {});
      if (!response.ok) throw new GitHubError(`GET ${path}: ${response.status}`, response.status);
      const page = await response.json();
      const list = key === undefined ? page : (page as Record<string, unknown>)[key];
      items.push(...(list as T[]));
      url = nextLink(response.headers.get('link'));
    }
    return items;
  };
  const graphql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const result = await request<{ data?: T; errors?: { message: string }[] }>('POST', 'graphql', {
      body: { query, variables },
    });
    if (result.errors !== undefined && result.errors.length > 0) {
      throw new GitHubError(`graphql: ${result.errors.map((e) => e.message).join('; ')}`, 200);
    }
    return result.data as T;
  };
  return { request, paginate, graphql };
}

/** A token from the environment, or the GitHub CLI's login as a person running Talos locally. */
export async function tokenFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const fromEnv = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const { stdout } = await promisify(execFile)('gh', ['auth', 'token']);
    const token = stdout.trim();
    if (token !== '') return token;
  } catch {
    // Falls through to the error below, which says what to do.
  }
  throw new GitHubError('no GitHub token: set GITHUB_TOKEN or run `gh auth login`', 401);
}

/** `owner/name` of the repository at `cwd`, from the environment or the `origin` remote. */
export function repoFromRemote(remoteUrl: string): string | undefined {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match?.[1];
}

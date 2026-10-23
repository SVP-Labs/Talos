import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from '../../core/check.js';

/** One vendor feed: `name` names its recorded copy, `url` where it lives. */
export type FeedRequest = { readonly name: string; readonly url: string };

/** Fetches a feed's body; throws `EngineError` when it can't. */
export type Fetcher = (request: FeedRequest) => Promise<string>;

/** Setting it to a directory of recorded feeds (`<name>.json`) keeps the check off the network. */
export const FEEDS_VARIABLE = 'TALOS_RUNTIME_FEEDS';

const TIMEOUT_MS = 30_000;

/** The part of `fetch` the feeds use. */
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The live feeds, through `fetchImpl`. Node's `fetch` uses `HTTPS_PROXY` only when
 * `NODE_USE_ENV_PROXY=1` is set, as it must be behind a proxy.
 */
export function httpFetcher(fetchImpl: FetchLike = fetch): Fetcher {
  return async ({ name, url }) => {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'talos-runtime-check' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined);
    if (response === undefined) throw new EngineError(`the ${name} feed could not be reached`);
    if (!response.ok) throw new EngineError(`the ${name} feed answered HTTP ${response.status}`);
    return response.text().catch((): never => {
      throw new EngineError(`the ${name} feed was cut off`);
    });
  };
}

export const networkFetcher: Fetcher = httpFetcher();

/** Recorded feeds: `<dir>/<name>.json`. */
export function fixtureFetcher(dir: string): Fetcher {
  return async ({ name }) => {
    try {
      return await readFile(join(dir, `${name}.json`), 'utf8');
    } catch {
      throw new EngineError(`${FEEDS_VARIABLE} has no recorded ${name}.json`);
    }
  };
}

const TTL_MS = 10 * 60 * 1000;

/**
 * Shares one fetch of each feed for `ttlMs`, across every check and repository a process
 * judges; a failed fetch is forgotten, so the next caller tries again.
 */
export function cachedFetcher(fetcher: Fetcher, ttlMs = TTL_MS, now = Date.now): Fetcher {
  const cache = new Map<string, { readonly at: number; readonly body: Promise<string> }>();
  return (request) => {
    const known = cache.get(request.url);
    if (known !== undefined && now() - known.at < ttlMs) return known.body;
    const body = fetcher(request);
    cache.set(request.url, { at: now(), body });
    void body.catch(() => {
      if (cache.get(request.url)?.body === body) cache.delete(request.url);
    });
    return body;
  };
}

/** The fetcher the environment asks for: recorded feeds when the variable is set, else live. */
export function fetcherFor(env: Readonly<Record<string, string | undefined>>): Fetcher {
  const dir = env[FEEDS_VARIABLE];
  return dir === undefined || dir === '' ? networkFetcher : fixtureFetcher(dir);
}

let shared: { readonly dir: string | undefined; readonly fetcher: Fetcher } | undefined;

/** The process's cached fetcher, per `fetcherFor(process.env)`. */
export function defaultFetcher(): Fetcher {
  const dir = process.env[FEEDS_VARIABLE];
  if (shared === undefined || shared.dir !== dir) {
    shared = { dir, fetcher: cachedFetcher(fetcherFor(process.env)) };
  }
  return shared.fetcher;
}

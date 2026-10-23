import { EngineError, type Memo } from '../../core/check.js';

export type HttpRequest = {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  /** A JSON body, for `POST`. */
  readonly body?: string;
};

type HttpResponse = { readonly status: number; readonly body: string };

/** Answers any HTTP status; throws only when the server can't be reached. */
export type Fetcher = (request: HttpRequest) => Promise<HttpResponse>;

/** What a registry lookup needs: the network, and the run's cache. */
export type Lookup = { readonly fetcher: Fetcher; readonly memo: Memo };

const TIMEOUT_MS = 60_000;

/**
 * The network. Node's `fetch` uses `HTTPS_PROXY` only when `NODE_USE_ENV_PROXY=1` is set, as it
 * must be behind a proxy.
 */
export const httpFetcher: Fetcher = async (request) => {
  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'talos-supply-check (https://github.com/SVP-Labs/Talos)',
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
};

/**
 * A 200 answer's body, or `undefined` when the registry has no such package (404). Anything else
 * leaves Talos unable to judge: an engine error.
 */
export async function getText(
  fetcher: Fetcher,
  request: HttpRequest,
  what: string,
): Promise<string | undefined> {
  let response: HttpResponse;
  try {
    response = await fetcher(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`${what} could not be reached: ${reason}`);
  }
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw new EngineError(`${what} answered HTTP ${response.status}`);
  return response.body;
}

/** `getText`, read as JSON. */
export async function getJson(
  fetcher: Fetcher,
  request: HttpRequest,
  what: string,
): Promise<unknown> {
  const body = await getText(fetcher, request, what);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new EngineError(`${what} answered with something other than JSON`);
  }
}

export { inPool } from '../../core/pool.js';

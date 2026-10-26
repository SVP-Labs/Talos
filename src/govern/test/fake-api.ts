import { github, type GitHub } from '../../github/api.js';

/**
 * A route table standing in for GitHub's REST and GraphQL API in tests. Each route answers with
 * a status and JSON shaped as GitHub's REST documentation shows it; an unknown route is a 404.
 */
type Call = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
};

export type Reply = { readonly status: number; readonly json?: unknown };

export type Route = {
  readonly method: string;
  readonly path: RegExp;
  readonly reply: (call: Call, match: RegExpExecArray) => Reply;
};

export function json(value: unknown, status = 200): Reply {
  return { status, json: value };
}

export const NO_CONTENT: Reply = { status: 204 };
export const NOT_FOUND: Reply = { status: 404, json: { message: 'Not Found' } };

export function route(method: string, path: RegExp, reply: Route['reply'] | Reply): Route {
  return { method, path, reply: typeof reply === 'function' ? reply : () => reply };
}

export type FakeApi = {
  readonly calls: Call[];
  readonly fetch: typeof fetch;
  readonly routes: Route[];
  client(): GitHub;
  /** Calls that change something, as `METHOD path` (GraphQL mutations as `GRAPHQL`). */
  writes(): string[];
};

function toResponse(reply: Reply): Response {
  if (reply.json === undefined) return new Response(null, { status: reply.status });
  return new Response(JSON.stringify(reply.json), {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  });
}

export function fakeApi(routes: Route[]): FakeApi {
  const calls: Call[] = [];
  const doFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = {
      method: init?.method ?? 'GET',
      path: decodeURIComponent(url.pathname.slice(1)),
      query: url.searchParams,
      body: raw === undefined ? undefined : JSON.parse(raw),
    };
    calls.push(call);
    for (const candidate of routes) {
      const match = candidate.path.exec(call.path);
      if (candidate.method === call.method && match !== null) {
        return Promise.resolve(toResponse(candidate.reply(call, match)));
      }
    }
    return Promise.resolve(toResponse(NOT_FOUND));
  };
  return {
    calls,
    fetch: doFetch,
    routes,
    client: () => github('token', { fetch: doFetch }),
    writes: () =>
      calls
        .filter((c) => c.method !== 'GET')
        .map((c) => (c.path === 'graphql' ? 'GRAPHQL' : `${c.method} ${c.path}`)),
  };
}

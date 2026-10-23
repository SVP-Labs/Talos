import { github, type GitHub } from '../../github/api.js';

/**
 * A fake of GitHub's REST API behind the real client: routes answer by method and path (the
 * client's `per_page=100` dropped), every call is recorded, and an unknown route answers 404 and
 * is listed in `unmatched` so a test can insist there were none.
 */
export type Answer = {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

export type Route = Answer | ((body: unknown) => Answer);

type Call = { readonly method: string; readonly path: string; readonly body: unknown };

export type Fake = {
  readonly gh: GitHub;
  readonly fetch: typeof fetch;
  readonly calls: Call[];
  readonly unmatched: string[];
  /** Adds or replaces a route. */
  on(method: string, path: string, route: Route): void;
};

const BASE = 'https://api.example.test';

export function normalize(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('per_page');
  const search = parsed.searchParams.toString();
  const query = search === '' ? '' : `?${search}`;
  return `${parsed.pathname.slice(1)}${query}`;
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function respond(answer: Answer): Response {
  const status = answer.status ?? 200;
  if (status === 204 || answer.body === undefined) {
    return new Response(null, { status, headers: answer.headers ?? {} });
  }
  const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
  const type = typeof answer.body === 'string' ? 'text/plain' : 'application/json';
  return new Response(text, { status, headers: { 'content-type': type, ...answer.headers } });
}

export function fakeGitHub(routes: Readonly<Record<string, Route>> = {}): Fake {
  const table = new Map<string, Route>(Object.entries(routes));
  const calls: Call[] = [];
  const unmatched: string[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const method = init?.method ?? 'GET';
    const path = normalize(inputUrl(input));
    const raw = init?.body;
    const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    calls.push({ method, path, body });
    const route = table.get(`${method} ${path}`);
    if (route === undefined) {
      unmatched.push(`${method} ${path}`);
      return Promise.resolve(new Response('{}', { status: 404 }));
    }
    return Promise.resolve(respond(typeof route === 'function' ? route(body) : route));
  };
  return {
    gh: github('token', { baseUrl: BASE, fetch: fakeFetch }),
    fetch: fakeFetch,
    calls,
    unmatched,
    on: (method, path, route) => {
      table.set(`${method} ${path}`, route);
    },
  };
}

/** The `installation/repositories` answer for repositories given as `owner/name`. */
export function installation(
  repos: readonly {
    readonly id: number;
    readonly name: string;
    readonly private?: boolean;
    readonly archived?: boolean;
    readonly talos?: string | undefined;
  }[],
): Answer {
  return {
    body: {
      total_count: repos.length,
      repositories: repos.map((repo) => ({
        id: repo.id,
        full_name: repo.name,
        name: repo.name.split('/')[1],
        default_branch: 'main',
        private: repo.private ?? true,
        archived: repo.archived ?? false,
        custom_properties: repo.talos === undefined ? {} : { talos: repo.talos },
      })),
    },
  };
}

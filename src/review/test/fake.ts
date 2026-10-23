import { z } from 'zod';
import { github, type GitHub } from '../../github/api.js';

/**
 * A stateful GitHub for the review's tests: the pull request, issue, contents, check-run and
 * GraphQL endpoints `talos/review` uses, answering with the shapes GitHub's REST documentation
 * gives (extra fields included, as GitHub sends them). The bearer token names the login acting.
 */

export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);

type Json = Record<string, unknown>;

export type FakeUser = { login: string; type: 'User' | 'Bot' };

export const person = (login: string): FakeUser => ({ login, type: 'User' });
export const app = (login: string): FakeUser => ({ login, type: 'Bot' });

export type FakePull = {
  number: number;
  state: 'open' | 'closed';
  draft: boolean;
  title: string;
  body: string | null;
  user: FakeUser;
  author_association: string;
  head: { sha: string; ref: string };
  base: { ref: string; sha: string };
  commits: number;
  changed_files: number;
  labels: string[];
};

export type FakeFile = {
  filename: string;
  status: string;
  previous_filename?: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

export type FakeReview = {
  user: FakeUser | null;
  state: string;
  commit_id: string | null;
  submitted_at?: string;
  body: string;
};

export type FakeCommit = {
  sha: string;
  verified: boolean;
  author: FakeUser | null;
  committer: FakeUser | null;
};

export type FakeEvent = {
  event: string;
  actor: FakeUser | null;
  created_at: string;
  label?: string;
};

export type FakeIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  events: FakeEvent[];
};

export type Call = { method: string; path: string; body: unknown; login: string };

const anyRecord = z.record(z.string(), z.unknown());

function record(value: unknown): Json {
  const parsed = anyRecord.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function userJson(user: FakeUser | null): Json | null {
  return user === null
    ? null
    : { login: user.login, id: 1, node_id: 'U_1', type: user.type, site_admin: false };
}

export class FakePrGitHub {
  readonly calls: Call[] = [];
  readonly pulls = new Map<number, FakePull>();
  readonly files = new Map<number, FakeFile[]>();
  readonly reviews = new Map<number, FakeReview[]>();
  readonly commits = new Map<number, FakeCommit[]>();
  readonly pullEvents = new Map<number, FakeEvent[]>();
  readonly issues = new Map<number, FakeIssue>();
  /** `ref:path` → text. */
  readonly contents = new Map<string, string>();
  /** The PR number → closing issues as `owner/name#N`. */
  readonly closing = new Map<number, string[]>();
  properties: Record<string, string | null> = { talos: 'canary', 'talos-agents': 'true' };
  /** `METHOD path` → status: every such call fails with it. */
  readonly failures = new Map<string, number>();
  now = '2026-10-23T12:00:00Z';
  private nextId = 9000;

  client(login = 'talos-reviewer[bot]'): GitHub {
    return github(login, { fetch: this.fetch });
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = {
      method: init?.method ?? 'GET',
      path: decodeURIComponent(url.pathname.slice(1)) + (url.search === '' ? '' : url.search),
      body: raw === undefined ? undefined : JSON.parse(raw),
      login: (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, ''),
    };
    this.calls.push(call);
    const failure = this.failures.get(`${call.method} ${url.pathname.slice(1)}`);
    if (failure !== undefined) return Promise.resolve(this.reply(failure, { message: 'failed' }));
    return Promise.resolve(this.route(call, url));
  };

  /** The writes made, as `METHOD path`. */
  writes(): string[] {
    return this.calls
      .filter((c) => c.method !== 'GET' && c.path !== 'graphql')
      .map((c) => `${c.method} ${c.path}`);
  }

  /** The bodies of the writes to a path. */
  bodies(method: string, path: string): Json[] {
    return this.calls
      .filter((c) => c.method === method && c.path === path)
      .map((c) => record(c.body));
  }

  private reply(status: number, json?: unknown): Response {
    if (json === undefined) return new Response(null, { status });
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  private route(call: Call, url: URL): Response {
    const path = url.pathname.slice(1);
    const pull = /^repos\/o\/r\/pulls\/(\d+)(?:\/(files|reviews|commits))?$/.exec(path);
    if (pull !== null) return this.pullRoute(call, Number(pull[1]), pull[2]);
    const issue = /^repos\/o\/r\/issues\/(\d+)(?:\/(events|labels))?$/.exec(path);
    if (issue !== null) return this.issueRoute(call, Number(issue[1]), issue[2]);
    const contents = /^repos\/o\/r\/contents\/(.+)$/.exec(decodeURIComponent(path));
    if (contents?.[1] !== undefined) {
      return this.contentRoute(contents[1], url.searchParams.get('ref') ?? '');
    }
    if (call.method === 'POST' && path === 'repos/o/r/check-runs') return this.checkRun(call);
    if (call.method === 'POST' && path === 'graphql') return this.graphql(call);
    if (call.method === 'GET' && path === 'repos/o/r/properties/values') {
      return this.reply(200, this.propertyValues());
    }
    return this.reply(404, { message: 'Not Found' });
  }

  private propertyValues(): Json[] {
    return Object.entries(this.properties).map(([name, value]) => ({ property_name: name, value }));
  }

  private pullRoute(call: Call, n: number, part: string | undefined): Response {
    const pull = this.pulls.get(n);
    if (pull === undefined) return this.reply(404, { message: 'Not Found' });
    if (part === undefined) return this.reply(200, this.pullJson(pull));
    if (part === 'files') return this.reply(200, this.files.get(n) ?? []);
    if (part === 'commits') {
      return this.reply(
        200,
        (this.commits.get(n) ?? []).map((c) => this.commitJson(c)),
      );
    }
    if (call.method === 'POST') return this.submit(call, n);
    return this.reply(
      200,
      (this.reviews.get(n) ?? []).map((r, i) => this.reviewJson(r, i)),
    );
  }

  private pullJson(pull: FakePull): Json {
    return {
      url: `https://api.github.com/repos/o/r/pulls/${pull.number}`,
      id: pull.number,
      number: pull.number,
      state: pull.state,
      draft: pull.draft,
      title: pull.title,
      body: pull.body,
      user: userJson(pull.user),
      author_association: pull.author_association,
      labels: pull.labels.map((name) => ({ id: 1, name, color: '0e8a16' })),
      head: { label: `o:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha },
      base: { label: `o:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha },
      commits: pull.commits,
      changed_files: pull.changed_files,
      merged: false,
    };
  }

  private commitJson(commit: FakeCommit): Json {
    return {
      sha: commit.sha,
      commit: {
        message: '[T-1]: change',
        verification: { verified: commit.verified, reason: commit.verified ? 'valid' : 'unsigned' },
      },
      author: userJson(commit.author),
      committer: userJson(commit.committer),
    };
  }

  private reviewJson(review: FakeReview, index: number): Json {
    return {
      id: 100 + index,
      node_id: `PRR_${index}`,
      user: userJson(review.user),
      body: review.body,
      state: review.state,
      commit_id: review.commit_id,
      submitted_at: review.submitted_at,
      author_association: 'NONE',
    };
  }

  private submit(call: Call, n: number): Response {
    const body = record(call.body);
    const event = typeof body.event === 'string' ? body.event : 'COMMENT';
    const states: Record<string, string> = {
      APPROVE: 'APPROVED',
      REQUEST_CHANGES: 'CHANGES_REQUESTED',
      COMMENT: 'COMMENTED',
    };
    const review: FakeReview = {
      user: call.login.endsWith('[bot]') ? app(call.login) : person(call.login),
      state: states[event] ?? 'COMMENTED',
      commit_id: typeof body.commit_id === 'string' ? body.commit_id : null,
      submitted_at: this.now,
      body: typeof body.body === 'string' ? body.body : '',
    };
    const list = this.reviews.get(n) ?? [];
    list.push(review);
    this.reviews.set(n, list);
    return this.reply(200, this.reviewJson(review, list.length - 1));
  }

  private issueRoute(call: Call, n: number, part: string | undefined): Response {
    if (part === 'events') {
      const events = this.issues.get(n)?.events ?? this.pullEvents.get(n) ?? [];
      return this.reply(
        200,
        events.map((e, i) => this.eventJson(e, i)),
      );
    }
    const issue = this.issues.get(n);
    if (issue === undefined) return this.reply(404, { message: 'Not Found' });
    if (part === 'labels' && call.method === 'POST') {
      const labels = record(call.body).labels;
      const added = z.array(z.string()).catch([]).parse(labels);
      issue.labels.push(...added.filter((l) => !issue.labels.includes(l)));
      return this.reply(
        200,
        issue.labels.map((name) => ({ name })),
      );
    }
    return this.reply(200, {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: 'open',
      labels: issue.labels.map((name) => ({ name, color: '0e8a16' })),
      user: userJson(person('SvenPGH')),
      author_association: 'OWNER',
      created_at: '2026-10-01T00:00:00Z',
    });
  }

  private eventJson(event: FakeEvent, index: number): Json {
    return {
      id: index + 1,
      node_id: `E_${index}`,
      event: event.event,
      actor: userJson(event.actor),
      created_at: event.created_at,
      commit_id: null,
      ...(event.label === undefined ? {} : { label: { name: event.label, color: '0e8a16' } }),
    };
  }

  private contentRoute(path: string, ref: string): Response {
    const text = this.contents.get(`${ref}:${path}`);
    if (text === undefined) return this.reply(404, { message: 'Not Found' });
    return this.reply(200, {
      type: 'file',
      encoding: 'base64',
      size: text.length,
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      content: Buffer.from(text, 'utf8').toString('base64'),
      sha: 'blob-sha',
    });
  }

  private checkRun(call: Call): Response {
    const body = record(call.body);
    this.nextId += 1;
    return this.reply(201, {
      id: this.nextId,
      name: body.name,
      head_sha: body.head_sha,
      status: body.status ?? (body.conclusion === undefined ? 'queued' : 'completed'),
      conclusion: body.conclusion ?? null,
      started_at: this.now,
      completed_at: body.completed_at ?? null,
      app: { id: 2, slug: 'talos-reviewer' },
    });
  }

  private graphql(call: Call): Response {
    const variables = record(record(call.body).variables);
    const n = typeof variables.number === 'number' ? variables.number : 0;
    const refs = this.closing.get(n) ?? [];
    const nodes = refs.map((ref) => {
      const [repo = '', number = '0'] = ref.split('#');
      return { number: Number(number), repository: { nameWithOwner: repo } };
    });
    return this.reply(200, {
      data: {
        repository: {
          pullRequest: { closingIssuesReferences: { totalCount: nodes.length, nodes } },
        },
      },
    });
  }
}

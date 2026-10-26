import { crc32, deflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { github, type GitHub } from '../../github/api.js';

/**
 * A small, stateful GitHub for tests: the REST endpoints the claim protocol and the caller's
 * jobs use, with response shapes from GitHub's REST documentation. The bearer token names the
 * login acting, so `fake.client('thea-svp[bot]')` comments as Thea's App.
 */

type FakeComment = {
  id: number;
  body: string;
  user: string;
  author_association: string;
  created_at: string;
};

export type FakeIssue = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  user: string;
  author_association: string;
  created_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
  comments: FakeComment[];
  timeline: { event: string; created_at: string; label?: { name: string } }[];
};

export type FakePull = {
  number: number;
  draft: boolean;
  state: 'open' | 'closed';
  updated_at: string;
  head: string;
};

export type FakeLabel = { name: string; color: string; description: string | null };

export type FakeArtifact = {
  id: number;
  /** The workflow run that uploaded it, when a test lists a run's artifacts. */
  run?: number;
  name: string;
  created_at: string;
  expired: boolean;
  size_in_bytes: number;
  zip: Uint8Array;
};

/** A workflow run, as the runs list and a GraphQL `WorkflowRun` node describe it. */
export type FakeRun = {
  id: number;
  event: string;
  created_at: string;
  head_branch: string;
  /** The workflow file the run ran, as GraphQL names it. */
  file: { path: string; repositoryName: string };
};

export type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  login: string;
};

type Reply = {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
};

type Handler = (call: Call, match: RegExpExecArray) => Reply;

function ok(json: unknown, status = 200): Reply {
  return { status, json };
}

const NOT_FOUND: Reply = { status: 404, json: { message: 'Not Found' } };
const NO_CONTENT: Reply = { status: 204 };

const anyRecord = z.record(z.string(), z.unknown()).catch({});
const stringList = z.array(z.string()).catch([]);

function record(value: unknown): Record<string, unknown> {
  return anyRecord.parse(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class FakeGitHub {
  readonly calls: Call[] = [];
  defaultBranch = 'main';
  /** The organisation's custom properties on the repository, such as `talos-agents`. */
  readonly properties: Record<string, string> = {};
  readonly refs = new Map<string, string>([['main', 'sha-main']]);
  readonly commitDates = new Map<string, string>([['sha-main', '2026-10-01T00:00:00Z']]);
  readonly issues = new Map<number, FakeIssue>();
  readonly pulls: FakePull[] = [];
  readonly labels: FakeLabel[] = [];
  readonly files = new Map<string, string>();
  readonly artifacts: FakeArtifact[] = [];
  readonly runs: FakeRun[] = [];
  /** `METHOD path` → status: the next such call fails with it. */
  readonly failures = new Map<string, number>();
  /** Answers GraphQL queries. */
  graphql: (query: string, variables: Record<string, unknown>) => unknown = () => ({});
  /** When events the fake records happen: the real clock, as the commands under test use it. */
  now = new Date().toISOString();
  private nextId = 5000;

  private readonly routes: [string, RegExp, Handler][] = [
    ['GET', /^repos\/o\/r$/, () => this.repository()],
    ['GET', /^repos\/o\/r\/git\/ref\/heads\/(.+)$/, (_c, m) => this.getRef(m)],
    ['GET', /^repos\/o\/r\/git\/matching-refs\/heads\/(.*)$/, (_c, m) => this.matchingRefs(m)],
    ['POST', /^repos\/o\/r\/git\/refs$/, (c) => this.createRef(c)],
    ['DELETE', /^repos\/o\/r\/git\/refs\/heads\/(.+)$/, (_c, m) => this.deleteRef(m)],
    ['GET', /^repos\/o\/r\/branches\/(.+)$/, (_c, m) => this.branch(m)],
    ['GET', /^repos\/o\/r\/issues$/, (c) => this.listIssues(c)],
    ['POST', /^repos\/o\/r\/issues$/, (c) => this.createIssue(c)],
    ['PATCH', /^repos\/o\/r\/issues\/comments\/(\d+)$/, (c, m) => this.editComment(c, m)],
    ['GET', /^repos\/o\/r\/issues\/(\d+)$/, (_c, m) => this.issueReply(m)],
    ['PATCH', /^repos\/o\/r\/issues\/(\d+)$/, (c, m) => this.editIssue(c, m)],
    ['POST', /^repos\/o\/r\/issues\/(\d+)\/labels$/, (c, m) => this.addLabels(c, m)],
    ['DELETE', /^repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/, (_c, m) => this.removeLabel(m)],
    ['GET', /^repos\/o\/r\/issues\/(\d+)\/comments$/, (_c, m) => this.comments(m)],
    ['POST', /^repos\/o\/r\/issues\/(\d+)\/comments$/, (c, m) => this.addComment(c, m)],
    ['GET', /^repos\/o\/r\/issues\/(\d+)\/timeline$/, (_c, m) => this.timeline(m)],
    ['GET', /^repos\/o\/r\/pulls$/, (c) => this.listPulls(c)],
    ['GET', /^repos\/o\/r\/pulls\/(\d+)$/, (_c, m) => this.pull(m)],
    ['PATCH', /^repos\/o\/r\/pulls\/(\d+)$/, (c, m) => this.editPull(c, m)],
    ['GET', /^repos\/o\/r\/labels$/, () => ok(this.labels)],
    ['POST', /^repos\/o\/r\/labels$/, (c) => this.createLabel(c)],
    ['PATCH', /^repos\/o\/r\/labels\/(.+)$/, (c, m) => this.editLabel(c, m)],
    ['GET', /^repos\/o\/r\/contents\/(.+)$/, (c, m) => this.contents(c, m)],
    ['GET', /^repos\/o\/r\/actions\/artifacts$/, (c) => this.listArtifacts(c)],
    ['GET', /^repos\/o\/r\/actions\/runs$/, (c) => this.listRuns(c)],
    ['GET', /^repos\/o\/r\/actions\/runs\/(\d+)\/artifacts$/, (_c, m) => this.runArtifacts(m)],
    ['GET', /^repos\/o\/r\/actions\/artifacts\/(\d+)\/zip$/, (_c, m) => this.redirect(m)],
    ['GET', /^storage\/(\d+)$/, (c, m) => this.download(c, m)],
    ['POST', /^graphql$/, (c) => this.answerGraphql(c)],
  ];

  /** A client acting as `login`. */
  client(login = 'talos-reviewer[bot]'): GitHub {
    return github(login, { fetch: this.fetch });
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = {
      method: init?.method ?? 'GET',
      path: decodeURIComponent(url.pathname.slice(1)),
      query: url.searchParams,
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      login: auth.replace(/^Bearer /, ''),
    };
    this.calls.push(call);
    return Promise.resolve(this.respond(this.route(call)));
  };

  private route(call: Call): Reply {
    const failure = this.failures.get(`${call.method} ${call.path}`);
    if (failure !== undefined) {
      this.failures.delete(`${call.method} ${call.path}`);
      return { status: failure, json: { message: 'failed' } };
    }
    for (const [method, pattern, handler] of this.routes) {
      const match = pattern.exec(call.path);
      if (method === call.method && match !== null) return handler(call, match);
    }
    return NOT_FOUND;
  }

  private respond(reply: Reply): Response {
    if (reply.bytes !== undefined) {
      return new Response(Buffer.from(reply.bytes), {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    }
    if (reply.json === undefined) {
      return new Response(null, { status: reply.status, headers: reply.headers ?? {} });
    }
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers },
    });
  }

  /** Writes calls that changed something, as `METHOD path`. */
  writes(): string[] {
    return this.calls
      .filter((c) => c.method !== 'GET' && c.path !== 'graphql')
      .map((c) => `${c.method} ${c.path}`);
  }

  addIssue(issue: Partial<FakeIssue> & { number: number }): FakeIssue {
    const full: FakeIssue = {
      title: `Issue ${issue.number}`,
      body: '',
      state: 'open',
      state_reason: null,
      labels: [],
      user: 'SvenPGH',
      author_association: 'OWNER',
      created_at: '2026-10-01T00:00:00Z',
      closed_at: null,
      comments: [],
      timeline: [],
      ...issue,
    };
    this.issues.set(full.number, full);
    return full;
  }

  private issueJson(issue: FakeIssue): unknown {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.state_reason,
      labels: issue.labels.map((name) => ({ name, color: '000000' })),
      user: { login: issue.user, type: issue.user.endsWith('[bot]') ? 'Bot' : 'User' },
      author_association: issue.author_association,
      created_at: issue.created_at,
      closed_at: issue.closed_at,
      ...(issue.pull_request === undefined ? {} : { pull_request: issue.pull_request }),
    };
  }

  private repository(): Reply {
    return ok({
      id: 1,
      full_name: 'o/r',
      default_branch: this.defaultBranch,
      custom_properties: this.properties,
    });
  }

  private getRef(m: RegExpExecArray): Reply {
    const sha = this.refs.get(m[1] ?? '');
    return sha === undefined
      ? NOT_FOUND
      : ok({ ref: `refs/heads/${m[1] ?? ''}`, object: { sha, type: 'commit' } });
  }

  private matchingRefs(m: RegExpExecArray): Reply {
    const prefix = m[1] ?? '';
    return ok(
      [...this.refs]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha, type: 'commit' } })),
    );
  }

  private createRef(call: Call): Reply {
    const body = record(call.body);
    const name = (text(body.ref) ?? '').replace(/^refs\/heads\//, '');
    if (this.refs.has(name)) return { status: 422, json: { message: 'Reference already exists' } };
    this.refs.set(name, text(body.sha) ?? '');
    return ok({ ref: `refs/heads/${name}`, object: { sha: body.sha } }, 201);
  }

  private deleteRef(m: RegExpExecArray): Reply {
    if (!this.refs.delete(m[1] ?? '')) {
      return { status: 422, json: { message: 'Reference does not exist' } };
    }
    for (const pull of this.pulls.filter((p) => p.head === m[1] && p.state === 'open')) {
      pull.state = 'closed';
    }
    return NO_CONTENT;
  }

  private branch(m: RegExpExecArray): Reply {
    const sha = this.refs.get(m[1] ?? '');
    if (sha === undefined) return NOT_FOUND;
    const date = this.commitDates.get(sha) ?? '2026-10-01T00:00:00Z';
    return ok({ name: m[1], commit: { sha, commit: { committer: { name: 'x', date } } } });
  }

  private issueReply(m: RegExpExecArray): Reply {
    const issue = this.issues.get(Number(m[1]));
    return issue === undefined ? NOT_FOUND : ok(this.issueJson(issue));
  }

  private listIssues(call: Call): Reply {
    const state = call.query.get('state') ?? 'open';
    const wanted = (call.query.get('labels') ?? '').split(',').filter(Boolean);
    const listed = [...this.issues.values()].filter(
      (i) => (state === 'all' || i.state === state) && wanted.every((l) => i.labels.includes(l)),
    );
    return ok(listed.map((i) => this.issueJson(i)));
  }

  private createIssue(call: Call): Reply {
    const body = record(call.body);
    const labels = stringList.parse(body.labels);
    const number = Math.max(0, ...this.issues.keys(), ...this.pulls.map((p) => p.number)) + 1;
    const issue = this.addIssue({
      number,
      title: text(body.title) ?? '',
      body: text(body.body) ?? '',
      labels,
      user: call.login,
      author_association: 'NONE',
      created_at: this.now,
      timeline: labels.map((name) => ({ event: 'labeled', created_at: this.now, label: { name } })),
    });
    return ok(this.issueJson(issue), 201);
  }

  private editIssue(call: Call, m: RegExpExecArray): Reply {
    const issue = this.issues.get(Number(m[1]));
    if (issue === undefined) return NOT_FOUND;
    const body = record(call.body);
    issue.title = text(body.title) ?? issue.title;
    issue.body = text(body.body) ?? issue.body;
    const state = text(body.state);
    if (state === 'open' || state === 'closed') issue.state = state;
    return ok(this.issueJson(issue));
  }

  private addLabels(call: Call, m: RegExpExecArray): Reply {
    const issue = this.issues.get(Number(m[1]));
    if (issue === undefined) return NOT_FOUND;
    for (const name of stringList.parse(record(call.body).labels)) {
      if (issue.labels.includes(name)) continue;
      issue.labels.push(name);
      issue.timeline.push({ event: 'labeled', created_at: this.now, label: { name } });
    }
    return ok(issue.labels.map((name) => ({ name })));
  }

  private removeLabel(m: RegExpExecArray): Reply {
    const issue = this.issues.get(Number(m[1]));
    const index = issue?.labels.indexOf(m[2] ?? '') ?? -1;
    if (issue === undefined || index === -1) return NOT_FOUND;
    issue.labels.splice(index, 1);
    return ok(issue.labels.map((name) => ({ name })));
  }

  private comments(m: RegExpExecArray): Reply {
    const issue = this.issues.get(Number(m[1]));
    if (issue === undefined) return NOT_FOUND;
    return ok(
      issue.comments.map((c) => ({
        id: c.id,
        body: c.body,
        user: { login: c.user },
        author_association: c.author_association,
        created_at: c.created_at,
      })),
    );
  }

  private addComment(call: Call, m: RegExpExecArray): Reply {
    const issue = this.issues.get(Number(m[1])) ?? this.pullAsIssue(Number(m[1]));
    if (issue === undefined) return NOT_FOUND;
    this.nextId += 1;
    const comment: FakeComment = {
      id: this.nextId,
      body: text(record(call.body).body) ?? '',
      user: call.login,
      author_association: call.login.endsWith('[bot]') ? 'NONE' : 'OWNER',
      created_at: this.now,
    };
    issue.comments.push(comment);
    return ok({ ...comment, user: { login: comment.user } }, 201);
  }

  private pullAsIssue(n: number): FakeIssue | undefined {
    if (!this.pulls.some((p) => p.number === n)) return undefined;
    return this.addIssue({ number: n, pull_request: { url: `pulls/${n}` } });
  }

  private editComment(call: Call, m: RegExpExecArray): Reply {
    const id = Number(m[1]);
    const comment = [...this.issues.values()].flatMap((i) => i.comments).find((c) => c.id === id);
    if (comment === undefined) return NOT_FOUND;
    comment.body = text(record(call.body).body) ?? comment.body;
    return ok({ ...comment, user: { login: comment.user } });
  }

  private timeline(m: RegExpExecArray): Reply {
    const issue = this.issues.get(Number(m[1]));
    return issue === undefined ? NOT_FOUND : ok(issue.timeline);
  }

  private listPulls(call: Call): Reply {
    const state = call.query.get('state') ?? 'open';
    const head = call.query.get('head')?.replace(/^o:/, '');
    const listed = this.pulls.filter(
      (p) => (state === 'all' || p.state === state) && (head === undefined || p.head === head),
    );
    return ok(
      listed.map((p) => ({
        number: p.number,
        draft: p.draft,
        state: p.state,
        updated_at: p.updated_at,
        head: { ref: p.head, sha: this.refs.get(p.head) ?? 'gone' },
      })),
    );
  }

  private pull(m: RegExpExecArray): Reply {
    const pull = this.pulls.find((p) => p.number === Number(m[1]));
    if (pull === undefined) return NOT_FOUND;
    const head = { ref: pull.head, sha: this.refs.get(pull.head) ?? 'gone' };
    const base = { ref: this.defaultBranch, sha: this.refs.get(this.defaultBranch) ?? 'gone' };
    return ok({ number: pull.number, draft: pull.draft, state: pull.state, head, base });
  }

  private editPull(call: Call, m: RegExpExecArray): Reply {
    const pull = this.pulls.find((p) => p.number === Number(m[1]));
    if (pull === undefined) return NOT_FOUND;
    const state = text(record(call.body).state);
    if (state === 'open' || state === 'closed') pull.state = state;
    return ok({ number: pull.number, state: pull.state });
  }

  private createLabel(call: Call): Reply {
    const body = record(call.body);
    const label = {
      name: text(body.name) ?? '',
      color: text(body.color) ?? '',
      description: text(body.description) ?? null,
    };
    if (this.labels.some((l) => l.name.toLowerCase() === label.name.toLowerCase())) {
      return { status: 422, json: { message: 'already_exists' } };
    }
    this.labels.push(label);
    return ok(label, 201);
  }

  private editLabel(call: Call, m: RegExpExecArray): Reply {
    const label = this.labels.find((l) => l.name === m[1]);
    if (label === undefined) return NOT_FOUND;
    const body = record(call.body);
    label.name = text(body.new_name) ?? label.name;
    label.color = text(body.color) ?? label.color;
    label.description = text(body.description) ?? label.description;
    return ok(label);
  }

  private contents(call: Call, m: RegExpExecArray): Reply {
    const ref = call.query.get('ref') ?? this.defaultBranch;
    const content = ref === this.defaultBranch ? this.files.get(m[1] ?? '') : undefined;
    if (content === undefined) return NOT_FOUND;
    return ok({
      type: 'file',
      encoding: 'base64',
      path: m[1],
      content: Buffer.from(content).toString('base64'),
    });
  }

  private listArtifacts(call: Call): Reply {
    const name = call.query.get('name');
    return this.artifactList(this.artifacts.filter((a) => name === null || a.name === name));
  }

  private listRuns(call: Call): Reply {
    const event = call.query.get('event');
    const since = /^>=(.+)$/.exec(call.query.get('created') ?? '')?.[1];
    const listed = this.runs.filter(
      (r) =>
        (event === null || r.event === event) &&
        (since === undefined || r.created_at.slice(0, 10) >= since),
    );
    return ok({
      total_count: listed.length,
      workflow_runs: listed.map((r) => ({
        id: r.id,
        node_id: `WFR_${r.id}`,
        event: r.event,
        created_at: r.created_at,
        head_branch: r.head_branch,
      })),
    });
  }

  /** Answers the GraphQL `nodes` query for workflow runs from {@link runs}. */
  runNodes(variables: Record<string, unknown>): unknown {
    const ids = stringList.parse(variables.ids);
    return {
      nodes: ids.map((id) => {
        const run = this.runs.find((r) => `WFR_${r.id}` === id);
        return run === undefined ? null : { databaseId: run.id, file: run.file };
      }),
    };
  }

  private runArtifacts(m: RegExpExecArray): Reply {
    return this.artifactList(this.artifacts.filter((a) => a.run === Number(m[1])));
  }

  private artifactList(listed: readonly FakeArtifact[]): Reply {
    return ok({
      total_count: listed.length,
      artifacts: listed.map((a) => ({
        id: a.id,
        name: a.name,
        size_in_bytes: a.size_in_bytes,
        expired: a.expired,
        created_at: a.created_at,
        archive_download_url: `https://api.github.com/repos/o/r/actions/artifacts/${a.id}/zip`,
        workflow_run: { id: a.run ?? a.id * 10, head_branch: 'T-1', head_sha: 'abc' },
      })),
    });
  }

  private redirect(m: RegExpExecArray): Reply {
    return { status: 302, headers: { location: `https://storage.example/storage/${m[1] ?? ''}` } };
  }

  private download(call: Call, m: RegExpExecArray): Reply {
    if (call.login !== '') return { status: 400, json: { message: 'token sent to storage' } };
    const artifact = this.artifacts.find((a) => a.id === Number(m[1]));
    return artifact === undefined ? NOT_FOUND : { status: 200, bytes: artifact.zip };
  }

  private answerGraphql(call: Call): Reply {
    const body = record(call.body);
    return ok({ data: this.graphql(text(body.query) ?? '', record(body.variables)) });
  }
}

/**
 * A zip archive as `actions/upload-artifact` writes one: deflated entries, and with `streamed`,
 * local headers whose sizes and checksums are zero because a data descriptor follows the data.
 * Each entry carries its CRC-32, so the system's `unzip` reads the archive too.
 */
export function makeZip(
  entries: Readonly<Record<string, string>>,
  options: { stored?: boolean; streamed?: boolean } = {},
): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const data = options.stored === true ? raw : deflateRawSync(raw);
    const fileName = Buffer.from(name);
    const checksum = crc32(raw);
    // A streamed entry leaves its checksum and sizes to the data descriptor after the data.
    const [crc, packed, size] =
      options.streamed === true ? [0, 0, 0] : [checksum, data.length, raw.length];
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.streamed === true ? 8 : 0, 6);
    local.writeUInt16LE(options.stored === true ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(fileName.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(options.stored === true ? 0 : 8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(offset, 42);
    const descriptor = options.streamed === true ? Buffer.alloc(16) : Buffer.alloc(0);
    locals.push(local, fileName, data, descriptor);
    central.push(entry, fileName);
    offset += local.length + fileName.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

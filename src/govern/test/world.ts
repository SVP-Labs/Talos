import { z } from 'zod';
import {
  fakeApi,
  type FakeApi,
  json,
  NO_CONTENT,
  NOT_FOUND,
  type Reply,
  route,
} from './fake-api.js';

/**
 * A stateful repository `SVP-Labs/demo` behind the fake API: what `talos govern` reads and writes,
 * so a test can govern it, then govern it again and see nothing change.
 */
const HEAD = 'c'.repeat(40);

/** `talos-reviewer`'s App id in the fake organisation. */
const REVIEWER_APP_ID = 5465977;

export type World = {
  exists: boolean;
  settings: Record<string, unknown>;
  files: Map<string, string>;
  rulesets: Map<number, Record<string, unknown>>;
  alerts: boolean;
  properties: Map<string, string>;
  members: Set<number>;
  head: string;
};

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function contentReply(world: World, path: string): Reply {
  if (path === '.github/workflows') {
    const listing = [...world.files.keys()]
      .filter((p) => p.startsWith('.github/workflows/'))
      .map((p) => ({ path: p, type: 'file' }));
    return listing.length === 0 ? NOT_FOUND : json(listing);
  }
  const text = world.files.get(path);
  if (text === undefined) return NOT_FOUND;
  return json({ type: 'file', encoding: 'base64', content: base64(text), sha: 'blob' });
}

const commitSchema = z.object({
  variables: z.object({
    input: z.object({
      expectedHeadOid: z.string(),
      fileChanges: z.object({
        additions: z.array(z.object({ path: z.string(), contents: z.string() })),
        deletions: z.array(z.object({ path: z.string() })),
      }),
    }),
  }),
});
const record = z.record(z.string(), z.unknown());
const propertiesSchema = z.object({
  properties: z.array(z.object({ property_name: z.string(), value: z.string() })),
});

function commit(world: World, body: unknown): Reply {
  const { input } = commitSchema.parse(body).variables;
  if (input.expectedHeadOid !== world.head) return json({ errors: [{ message: 'moved' }] });
  for (const file of input.fileChanges.additions) {
    world.files.set(file.path, Buffer.from(file.contents, 'base64').toString('utf8'));
  }
  for (const file of input.fileChanges.deletions) world.files.delete(file.path);
  world.head = 'd'.repeat(40);
  return json({ data: { createCommitOnBranch: { commit: { oid: world.head } } } });
}

export function worldApi(world: World, login = 'SvenPGH'): FakeApi {
  let nextRuleset = 100;
  return fakeApi([
    route('GET', /^user$/, json({ login })),
    route('GET', /^apps\/talos-reviewer$/, json({ id: REVIEWER_APP_ID, slug: 'talos-reviewer' })),
    route('GET', /^repos\/SVP-Labs\/demo$/, () =>
      world.exists ? json({ id: 42, default_branch: 'main', ...world.settings }) : NOT_FOUND,
    ),
    route('POST', /^orgs\/SVP-Labs\/repos$/, () => {
      world.exists = true;
      return json({ id: 42, full_name: 'SVP-Labs/demo' }, 201);
    }),
    route('GET', /^orgs\/SVP-Labs\/repos$/, () =>
      json(world.exists ? [{ id: 42, full_name: 'SVP-Labs/demo', default_branch: 'main' }] : []),
    ),
    route('PATCH', /^repos\/SVP-Labs\/demo$/, (call) => {
      Object.assign(world.settings, record.parse(call.body));
      return json({ id: 42 });
    }),
    route('GET', /^repos\/SVP-Labs\/demo\/git\/ref\/heads\/main$/, () =>
      json({ object: { sha: world.head } }),
    ),
    route('GET', /^repos\/SVP-Labs\/demo\/contents\/(.+)$/, (_c, m) =>
      contentReply(world, m[1] ?? ''),
    ),
    route('POST', /^graphql$/, (call) => commit(world, call.body)),
    route('GET', /^repos\/SVP-Labs\/demo\/rulesets$/, () =>
      json(
        [...world.rulesets.values()].map((r) => ({
          id: r.id,
          name: r.name,
          source_type: 'Repository',
        })),
      ),
    ),
    route('GET', /^repos\/SVP-Labs\/demo\/rulesets\/(\d+)$/, (_c, m) =>
      json(world.rulesets.get(Number(m[1]))),
    ),
    route('POST', /^repos\/SVP-Labs\/demo\/rulesets$/, (call) => {
      const id = nextRuleset;
      nextRuleset += 1;
      world.rulesets.set(id, { ...record.parse(call.body), id });
      return json({ id });
    }),
    route('PUT', /^repos\/SVP-Labs\/demo\/rulesets\/(\d+)$/, (call, m) => {
      world.rulesets.set(Number(m[1]), { ...record.parse(call.body), id: Number(m[1]) });
      return json({ id: Number(m[1]) });
    }),
    route('DELETE', /^repos\/SVP-Labs\/demo\/rulesets\/(\d+)$/, (_c, m) => {
      world.rulesets.delete(Number(m[1]));
      return NO_CONTENT;
    }),
    route('GET', /^repos\/SVP-Labs\/demo\/vulnerability-alerts$/, () =>
      world.alerts ? NO_CONTENT : NOT_FOUND,
    ),
    route('PUT', /^repos\/SVP-Labs\/demo\/vulnerability-alerts$/, () => {
      world.alerts = true;
      return NO_CONTENT;
    }),
    route('GET', /^repos\/SVP-Labs\/demo\/properties\/values$/, () =>
      json([...world.properties].map(([name, value]) => ({ property_name: name, value }))),
    ),
    route('PATCH', /^repos\/SVP-Labs\/demo\/properties\/values$/, (call) => {
      for (const v of propertiesSchema.parse(call.body).properties) {
        world.properties.set(v.property_name, v.value);
      }
      return NO_CONTENT;
    }),
    route(
      'GET',
      /^orgs\/SVP-Labs\/installations$/,
      json({
        total_count: 3,
        installations: [
          { id: 1, app_slug: 'thea-svp', app_id: 11, repository_selection: 'selected' },
          { id: 2, app_slug: 'talos-reviewer', app_id: 12, repository_selection: 'selected' },
          { id: 3, app_slug: 'talos-release', app_id: 13, repository_selection: 'all' },
        ],
      }),
    ),
    route('GET', /^user\/installations\/(\d+)\/repositories$/, (_c, m) =>
      json({
        total_count: 1,
        repositories: world.members.has(Number(m[1])) ? [{ id: 42 }] : [{ id: 7 }],
      }),
    ),
    route('PUT', /^user\/installations\/(\d+)\/repositories\/42$/, (_c, m) => {
      world.members.add(Number(m[1]));
      return NO_CONTENT;
    }),
  ]);
}

export function freshWorld(): World {
  return {
    exists: true,
    settings: {
      allow_rebase_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: true,
      pull_request_creation_policy: 'all',
    },
    files: new Map([['.github/workflows/gates.yml', 'uses: SVP-Labs/Workflows/gates.yml@v0']]),
    rulesets: new Map(),
    alerts: false,
    properties: new Map(),
    members: new Set(),
    head: HEAD,
  };
}

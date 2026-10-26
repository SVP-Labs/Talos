import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Io } from './io.js';
import { main } from './main.js';
import { orgWith } from './org.js';
import { loadTemplates } from '../govern/templates.js';
import { fakeApi, type FakeApi, json, route } from '../govern/test/fake-api.js';

const V1 = '1'.repeat(40);

type Org = {
  definitions: Map<string, Record<string, unknown>>;
  orgRulesets: Map<number, Record<string, unknown>>;
  talosRulesets: Map<number, Record<string, unknown>>;
};

const record = z.record(z.string(), z.unknown());

function store(map: Map<number, Record<string, unknown>>, body: unknown, id: number) {
  map.set(id, { ...record.parse(body), id });
  return json({ id });
}

function orgApi(org: Org, login = 'SvenPGH'): FakeApi {
  let next = 1;
  const list = (map: Map<number, Record<string, unknown>>) => () =>
    json([...map.values()].map((r) => ({ id: r.id, name: r.name, source_type: 'Repository' })));
  return fakeApi([
    route('GET', /^user$/, json({ login })),
    route('GET', /^repos\/SVP-Labs\/Talos$/, json({ id: 500 })),
    route('GET', /^apps\/talos-reviewer$/, json({ id: 600 })),
    route('GET', /^apps\/talos-release$/, json({ id: 700 })),
    route('GET', /^repos\/SVP-Labs\/Talos\/tags$/, json([{ name: 'v0.1.0', commit: { sha: V1 } }])),
    route('GET', /^orgs\/SVP-Labs\/properties\/schema$/, () =>
      json([...org.definitions].map(([name, d]) => ({ property_name: name, ...d }))),
    ),
    route('PUT', /^orgs\/SVP-Labs\/properties\/schema\/(.+)$/, (call, m) => {
      org.definitions.set(m[1] ?? '', record.parse(call.body));
      return json({});
    }),
    route('GET', /^orgs\/SVP-Labs\/rulesets$/, list(org.orgRulesets)),
    route('GET', /^orgs\/SVP-Labs\/rulesets\/(\d+)$/, (_c, m) =>
      json(org.orgRulesets.get(Number(m[1]))),
    ),
    route('POST', /^orgs\/SVP-Labs\/rulesets$/, (call) =>
      store(org.orgRulesets, call.body, next++),
    ),
    route('GET', /^repos\/SVP-Labs\/Talos\/rulesets$/, list(org.talosRulesets)),
    route('GET', /^repos\/SVP-Labs\/Talos\/rulesets\/(\d+)$/, (_c, m) =>
      json(org.talosRulesets.get(Number(m[1]))),
    ),
    route('POST', /^repos\/SVP-Labs\/Talos\/rulesets$/, (call) =>
      store(org.talosRulesets, call.body, next++),
    ),
  ]);
}

function io(): Io & { stdout: string; stderr: string } {
  const term = {
    cwd: '/nowhere',
    env: { GITHUB_TOKEN: 'token' },
    stdout: '',
    stderr: '',
    out: (text: string) => {
      term.stdout += text;
    },
    err: (text: string) => {
      term.stderr += text;
    },
  };
  return term;
}

function emptyOrg(): Org {
  return { definitions: new Map(), orgRulesets: new Map(), talosRulesets: new Map() };
}

describe('talos org', () => {
  it('sets up the organisation from the first release, then changes nothing', async () => {
    const org = emptyOrg();
    const deps = { fetch: orgApi(org).fetch, templates: loadTemplates };
    const term = io();
    expect(await orgWith(deps)(['init', '--seed', V1, '--json'], term)).toBe(0);
    expect(JSON.parse(term.stdout)).toMatchObject({
      schema: 'talos.org/1',
      ok: true,
      steps: { total: 8 },
    });
    expect([...org.definitions.keys()]).toEqual(['talos', 'talos-agents']);
    expect([...org.orgRulesets.values()].map((r) => r.name)).toEqual([
      'talos-evaluate',
      'talos-canary',
      'talos-stable',
    ]);
    expect([...org.talosRulesets.values()].map((r) => r.name)).toEqual([
      'talos-release-tags',
      'talos-channels',
      'talos-self-test',
    ]);
    const again = orgApi(org);
    expect(await orgWith({ fetch: again.fetch })(['init'], io())).toBe(0);
    expect(again.writes()).toEqual([]);

    const pins = io();
    expect(await orgWith({ fetch: orgApi(org).fetch })(['pins', '--json'], pins)).toBe(0);
    expect(JSON.parse(pins.stdout)).toMatchObject({
      pins: [
        { channel: 'evaluate', sha: V1, tag: 'v0.1.0', enforcement: 'evaluate' },
        { channel: 'canary', sha: V1, tag: 'v0.1.0', enforcement: 'active' },
        { channel: 'stable', sha: V1, tag: 'v0.1.0', enforcement: 'active' },
      ],
    });
    const text = io();
    await orgWith({ fetch: orgApi(org).fetch })(['pins'], text);
    expect(text.stdout).toContain('canary    v0.1.0');
  });

  it('plans without writing on --dry-run, and exits 1 when pins are missing', async () => {
    const api = orgApi(emptyOrg());
    const term = io();
    expect(await orgWith({ fetch: api.fetch })(['init', '--dry-run'], term)).toBe(0);
    expect(api.writes()).toEqual([]);
    expect(term.stdout).toContain('! ruleset:talos-canary');
    expect(await orgWith({ fetch: orgApi(emptyOrg()).fetch })(['pins'], io())).toBe(1);
  });

  it('refuses a seed that is not a release, and anyone but the owner', async () => {
    const term = io();
    expect(
      await orgWith({ fetch: orgApi(emptyOrg()).fetch })(['init', '--seed', 'f'.repeat(40)], term),
    ).toBe(1);
    expect(term.stderr).toMatch(/not the commit of a v\* tag/);
    expect(await orgWith({ fetch: orgApi(emptyOrg(), 'thea').fetch })(['init'], term)).toBe(1);
  });

  it('checks its arguments', async () => {
    const term = io();
    expect(await main(['org'], term)).toBe(3);
    expect(await main(['org', 'init', '--seed', 'abc'], term)).toBe(3);
  });
});

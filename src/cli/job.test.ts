import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Io, UsageError } from './io.js';
import { jobWith } from './job.js';
import type { AnalyzeDeps } from '../jobs/analyze.js';
import { finding, outcome, result } from '../jobs/test/findings.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

type Run = { code: number; line: Record<string, unknown>; lines: number };

describe('talos job', () => {
  let fake: FakeGitHub;
  let dir: string;

  beforeEach(async () => {
    fake = new FakeGitHub();
    fake.files.set('talos.yml', 'name: R\nprefix: R\n');
    dir = await mkdtemp(join(tmpdir(), 'talos-cli-job-'));
  });

  async function talos(
    argv: string[],
    env: Record<string, string>,
    payload: unknown = {},
    analyze?: AnalyzeDeps,
  ): Promise<Run> {
    await writeFile(join(dir, 'event.json'), JSON.stringify(payload));
    let out = '';
    const io: Io = {
      cwd: dir,
      env: {
        GITHUB_EVENT_PATH: join(dir, 'event.json'),
        GITHUB_REPOSITORY: 'o/r',
        TALOS_WORKDIR: join(dir, 'work'),
        ...env,
      },
      out: (text) => {
        out += text;
      },
      err: () => undefined,
    };
    const review = (): Promise<never[]> => Promise.resolve([]);
    const code = await jobWith({ fetch: fake.fetch, review, ...(analyze ? { analyze } : {}) })(
      argv,
      io,
    );
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return {
      code,
      line: Object.fromEntries(Object.entries(parsed)),
      lines: out.trim().split('\n').length,
    };
  }

  it('runs the act phase and prints one JSON line', async () => {
    const run = await talos(['workflow_dispatch', '--phase', 'act'], {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      TALOS_REVIEWER_TOKEN: 'talos-reviewer[bot]',
      GITHUB_TOKEN: 'github-actions[bot]',
    });
    expect(run.lines).toBe(1);
    expect(run.line).toMatchObject({
      schema: 'talos.job/1',
      event: 'workflow_dispatch',
      phase: 'act',
      repo: 'o/r',
      total: 5,
      failed: 2,
    });
    expect(run.code).toBe(1);
    expect(fake.labels.length).toBeGreaterThan(20);
    expect(
      fake.calls
        .filter((c) => c.path === 'repos/o/r/labels' && c.method === 'POST')
        .every((c) => c.login === 'talos-reviewer[bot]'),
    ).toBe(true);
  });

  it('exits 0 when nothing failed', async () => {
    const payload = { comment: { user: { login: 'mallory' }, author_association: 'NONE' } };
    const run = await talos(
      ['issue_comment', '--phase', 'act'],
      { TALOS_REVIEWER_TOKEN: 'talos-reviewer[bot]' },
      payload,
    );
    expect(run).toMatchObject({
      code: 0,
      line: { outcomes: [{ job: 'admission', result: 'skipped', detail: 'author not trusted' }] },
    });
    expect(fake.calls).toEqual([]);
  });

  it('runs the analyze phase on the checkout, holding no token', async () => {
    await writeFile(join(dir, 'talos.yml'), 'name: R\nprefix: R\n');
    const analyze: AnalyzeDeps = {
      checks: { debt: ['ts/lint'], mutation: [] },
      run: () => Promise.resolve(result([outcome('ts/lint', [finding('r/1', 'a.ts')])])),
      summary: () => Promise.resolve(),
    };
    const run = await talos(
      ['workflow_dispatch', '--phase', 'analyze'],
      { GITHUB_TOKEN: 'ignored' },
      {},
      analyze,
    );
    expect(run.code).toBe(0);
    const debt: unknown = JSON.parse(await readFile(join(dir, 'work', 'debt.json'), 'utf8'));
    expect(debt).toMatchObject({ schema: 'talos.debt/1', counts: { total: 1 } });
    expect(fake.calls).toEqual([]);
  });

  it("refuses the reviewer's token in the analyze phase", async () => {
    await expect(
      talos(['schedule', '--phase', 'analyze'], { TALOS_REVIEWER_TOKEN: 'x' }),
    ).rejects.toThrow(/must not hold the reviewer's token/);
  });

  it('refuses an event that is not the one GitHub delivered, and bad usage', async () => {
    await expect(
      talos(['issues', '--phase', 'act'], { GITHUB_EVENT_NAME: 'schedule' }),
    ).rejects.toThrow(/the event is schedule/);
    await expect(talos(['issues', '--phase', 'both'], {})).rejects.toThrow(UsageError);
    await expect(talos(['--phase', 'act'], {})).rejects.toThrow(/event/);
    await expect(
      talos(['issues', '--phase', 'act'], { GITHUB_REPOSITORY: 'nope' }),
    ).rejects.toThrow(/owner\/name/);
  });

  it('caps the outcomes it prints and clips their details', async () => {
    const payload = {
      action: 'opened',
      issue: { number: 1, user: { login: 'SvenPGH' }, author_association: 'OWNER' },
    };
    const run = await talos(['issues', '--phase', 'act'], {}, payload);
    expect(run).toMatchObject({
      code: 1,
      line: { outcomes: [{ job: 'readiness', result: 'failed' }] },
    });
  });
});

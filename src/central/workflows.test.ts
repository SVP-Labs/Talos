import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { pickRepositories } from './pick.js';
import { fakeGitHub, propertiesPath, propertyValues } from './test/fake-github.js';
import { carriesGeneratedMarker } from '../configs/header.js';

/**
 * The workflows Talos runs and ships, read as data: the rules every one keeps (pinned actions,
 * least privilege, no expression in a script), the gate's and the caller's shape, and the rules
 * that keep repository names out of the central jobs' public logs. The inline scripts that count
 * the repositories and find a pin are run against a fake `gh`, the count against Talos's own
 * lookup by index, and `bootstrap/php.sh` against a scratch repository.
 */

const ROOT = new URL('../../', import.meta.url);
const text = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');

const stepSchema = z.looseObject({
  name: z.string().optional(),
  id: z.string().optional(),
  if: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
});

const jobSchema = z.looseObject({
  name: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  if: z.string().optional(),
  environment: z.string().optional(),
  permissions: z.unknown(),
  strategy: z.looseObject({ matrix: z.unknown() }).optional(),
  steps: z.array(stepSchema),
});

const workflowSchema = z.looseObject({
  on: z.unknown(),
  permissions: z.unknown(),
  concurrency: z.unknown().optional(),
  jobs: z.record(z.string(), jobSchema),
});

type Job = z.infer<typeof jobSchema>;
type Step = z.infer<typeof stepSchema>;

const FILES = {
  gate: '.github/workflows/gate.yml',
  caller: '.github/workflows/talos.yml',
  selfTest: '.github/workflows/self-test.yml',
  release: '.github/workflows/release.yml',
  channels: '.github/workflows/channels.yml',
  sweep: '.github/workflows/runtime-sweep.yml',
  drift: '.github/workflows/drift.yml',
} as const;

const CENTRAL = [FILES.channels, FILES.sweep, FILES.drift];

const workflow = (path: string) => workflowSchema.parse(parse(text(path)));
const jobsOf = (path: string): [string, Job][] => Object.entries(workflow(path).jobs);
const stepsOf = (path: string): Step[] => jobsOf(path).flatMap(([, job]) => job.steps);
const needsOf = (job: Job): string[] => (job.needs === undefined ? [] : [job.needs].flat());
const tokenSteps = (job: Job): Step[] =>
  job.steps.filter((s) => s.uses?.startsWith('actions/create-github-app-token@') === true);

/** The step a test is about; a missing one fails the test by its name. */
function stepIn(job: Job | undefined, matches: (step: Step) => boolean, what: string): Step {
  const step = job?.steps.find((s) => matches(s));
  if (step === undefined) throw new Error(`no step ${what}`);
  return step;
}

const using =
  (action: string) =>
  (step: Step): boolean =>
    step.uses?.startsWith(`${action}@`) === true;

const named =
  (name: string) =>
  (step: Step): boolean =>
    step.name === name || step.id === name;

describe('every workflow', () => {
  const paths = [...Object.values(FILES), 'assets/workflows/talos.yml'];

  it('pins each action to a full commit, its version in a comment', () => {
    for (const path of paths) {
      const uses = text(path)
        .split('\n')
        .filter((line) => /^\s*(?:- )?uses:/.test(line));
      expect(uses.length, path).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line, path).toMatch(/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v?\d+\.\d+\.\d+$/);
      }
    }
  });

  it('grants nothing by default, and each job asks for what it needs', () => {
    for (const path of paths) {
      expect(workflow(path).permissions, path).toEqual({});
      for (const [id, job] of jobsOf(path)) expect(job.permissions, `${path} ${id}`).toBeDefined();
    }
  });

  it('passes no expression into a script: values reach scripts through env', () => {
    for (const path of paths) {
      for (const step of stepsOf(path)) {
        expect(step.run ?? '', `${path} ${step.name ?? ''}`).not.toContain('${{');
      }
    }
  });

  it('checks out without leaving credentials behind', () => {
    for (const path of paths) {
      for (const step of stepsOf(path).filter(
        (s) => s.uses?.startsWith('actions/checkout@') === true,
      )) {
        expect(step.with?.['persist-credentials'], path).toBe(false);
      }
    }
  });

  it("mints App tokens with the permissions they need, never all of the App's", () => {
    for (const path of paths) {
      for (const [, job] of jobsOf(path)) {
        for (const step of tokenSteps(job)) {
          const asked = Object.keys(step.with ?? {}).filter((k) => k.startsWith('permission-'));
          expect(asked.length, `${path} ${step.name ?? ''}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('takes identities from the organisation variables, repeating no default', () => {
    for (const path of paths) {
      expect(text(path), path).not.toMatch(/vars\.TALOS_\w+ \|\| '/);
    }
  });

  it('sets PHP up with pcov and composer, from one pinned action', () => {
    const setups = paths.flatMap((path) =>
      stepsOf(path).filter((s) => s.uses?.startsWith('shivammathur/setup-php@') === true),
    );
    expect(setups.length).toBeGreaterThan(0);
    expect(new Set(setups.map((s) => s.uses)).size).toBe(1);
    for (const step of setups) {
      expect(step.with).toMatchObject({ coverage: 'pcov', tools: 'composer' });
      expect(step.env).toEqual({ 'fail-fast': true, update: true });
    }
  });

  it('runs Talos through the launcher, which verifies the release first', () => {
    for (const path of paths.filter((p) => p !== FILES.selfTest && p !== FILES.release)) {
      const runs = stepsOf(path).flatMap((s) =>
        s.run?.includes('launch.ts') === true ? [s.run] : [],
      );
      expect(runs.length, path).toBeGreaterThan(0);
      expect(
        stepsOf(path).some((s) => /\bnpx\b|talos\.js/.test(s.run ?? '')),
        path,
      ).toBe(false);
    }
  });
});

const FIND_PIN = text('bootstrap/find-pin.sh');

/** The lines that do something: no blank lines, no comment lines, no indentation. */
function codeLines(script: string): string[] {
  return script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function inlinedFindPin(run: string): string[] {
  const lines = run.split('\n');
  const start = lines.indexOf('find_pin() {');
  const end = lines.indexOf('}', start);
  return start === -1 || end === -1 ? [] : codeLines(lines.slice(start + 1, end).join('\n'));
}

describe('the inlined pin lookup', () => {
  it('is bootstrap/find-pin.sh, in every job that finds the enforced release', () => {
    const fileLines = codeLines(FIND_PIN.slice(FIND_PIN.indexOf('set -euo pipefail')));
    let copies = 0;
    for (const path of [FILES.gate, FILES.caller, FILES.sweep, FILES.drift, FILES.channels]) {
      for (const step of stepsOf(path).filter((s) => s.run?.includes('find_pin() {') === true)) {
        expect(inlinedFindPin(step.run ?? ''), path).toEqual(fileLines);
        expect(step.run, path).toContain('pin="$(find_pin)"');
        copies += 1;
      }
    }
    expect(copies).toBe(9);
  });
});

describe('the gate', () => {
  const gate = workflow(FILES.gate);
  const jobs = gate.jobs;

  it('runs on PRs, including when one leaves draft, and on the merge queue', () => {
    expect(gate.on).toEqual({
      pull_request: { types: ['opened', 'synchronize', 'reopened', 'ready_for_review'] },
      merge_group: null,
    });
  });

  it('never cancels a run in progress, queues per PR or merge group, and holds no secret', () => {
    expect(gate.concurrency).toEqual({
      group:
        'talos-gate-${{ github.event.pull_request.number || github.event.merge_group.head_ref }}',
    });
    expect(text(FILES.gate)).not.toMatch(/cancel-in-progress|secrets\./);
    for (const [, job] of Object.entries(jobs)) {
      expect(
        job.permissions === undefined || JSON.stringify(job.permissions).includes('write'),
      ).toBe(false);
    }
  });

  it('names the verdict and engine jobs after the release, so promotion can count them', () => {
    expect(jobs.verdict?.name).toBe('verdict (talos ${{ needs.pin.outputs.version }})');
    expect(jobs.engine?.name).toBe('engine (talos ${{ needs.pin.outputs.version }})');
    expect(needsOf(jobs.engine!)).toEqual(['pin', 'verdict']);
    expect(jobs.engine?.if).toContain('!cancelled()');
    expect(jobs.engine?.steps[0]?.env?.CODE).toBe('${{ needs.verdict.outputs.code }}');
    expect(jobs.engine?.steps[0]?.run).toMatch(/0 \| 1\) .*\n\s*\*\) .*exit 1/);
  });

  it('plans, runs a matrix of checkouts at each commit, and uploads the verdict', () => {
    expect(needsOf(jobs.run!)).toEqual(['pin', 'plan']);
    expect(jobs.run?.strategy?.matrix).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
    const checkout = jobs.run?.steps.find((s) => s.with?.ref === '${{ matrix.sha }}');
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    const upload = jobs.verdict?.steps.find((s) => s.with?.name === 'talos-verdict');
    expect(String(upload?.with?.path)).toMatch(/verdict\.json[\s\S]*talos\.sarif/);
    expect(upload?.if).toContain('!cancelled()');
  });

  it("judges a commit without talos.yml by the head's, as the PR that adopts Talos needs", () => {
    const run = jobs.run?.steps.find(named('Run the checks'))?.run ?? '';
    expect(run).toContain('--config-from "$HEAD"');
  });

  it('runs every Talos command at the pin, checked out beside the repository', () => {
    for (const [id, job] of Object.entries(jobs).filter(([id]) => id !== 'engine')) {
      const kit = job.steps.find((s) => s.with?.path === 'talos-kit');
      expect(kit?.with?.repository, id).toBe('SVP-Labs/Talos');
    }
  });

  it('checks every run out with its full history, which the secrets scan reads', () => {
    for (const [id, job] of Object.entries(jobs)) {
      for (const step of job.steps.filter(
        (s) => s.uses?.startsWith('actions/checkout@') === true && s.with?.path === 'repo',
      )) {
        expect(step.with?.['fetch-depth'], id).toBe(0);
      }
    }
  });

  it("sets PHP up from each run's own matrix entry, only where a PHP component needs it", () => {
    expect(JSON.stringify(jobs.plan)).not.toContain('php.sh');
    expect(jobs.plan?.outputs).toEqual({
      matrix: '${{ steps.plan.outputs.matrix }}',
      base: '${{ steps.plan.outputs.base }}',
      head: '${{ steps.plan.outputs.head }}',
      tree: '${{ steps.plan.outputs.tree }}',
    });
    const steps = jobs.run?.steps ?? [];
    const php = steps.findIndex(using('shivammathur/setup-php'));
    expect(steps[php]?.if).toBe(
      "${{ steps.cached.outputs.cache-hit != 'true' && matrix.php != '' }}",
    );
    expect(steps[php]?.with?.['php-version']).toBe('${{ matrix.php }}');
    expect(php).toBeLessThan(steps.findIndex(named('Run the checks')));
  });

  it("caches a PR's base run by everything its result depends on, and never in the queue", () => {
    const run = jobs.run;
    const key = stepIn(run, named('key'), 'key');
    expect(key.if).toBe(
      "${{ github.event_name == 'pull_request' && matrix.sha == needs.plan.outputs.base }}",
    );
    expect(Object.keys(key.env ?? {})).toEqual(['VERSION', 'RUN_OS', 'TIERS', 'RUN_SHA', 'TREE']);
    expect(key.run).toContain('date -u +%F');
    const restore = stepIn(run, using('actions/cache/restore'), 'restoring the cache');
    const save = stepIn(run, using('actions/cache/save'), 'saving the cache');
    for (const step of [restore, save]) {
      expect(step.with?.key).toBe('${{ steps.key.outputs.key }}');
    }
    expect(save.if).toBe("${{ steps.aside.outputs.keep == 'true' }}");
    expect(stepIn(run, named('aside'), 'aside').run).toContain('.status != "error"');
    for (const name of ['Check out the commit', 'Set up Node', 'Run the checks']) {
      expect(stepIn(run, named(name), name).if).toContain(
        "steps.cached.outputs.cache-hit != 'true'",
      );
    }
    expect(text(FILES.gate)).not.toMatch(/restore-keys/);
  });
});

describe('the caller', () => {
  const caller = workflow(FILES.caller);

  it('is the same file Talos ships to every repository', () => {
    expect(readFileSync(new URL(FILES.caller, ROOT))).toEqual(
      readFileSync(new URL('assets/workflows/talos.yml', ROOT)),
    );
  });

  it("runs on the events the brief lists, and on a PR's edits", () => {
    expect(caller.on).toEqual({
      pull_request_target: {
        types: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited'],
      },
      merge_group: null,
      issues: null,
      issue_comment: null,
      pull_request_review: null,
      schedule: [{ cron: '17 3 * * *' }],
      workflow_dispatch: null,
    });
  });

  it('analyzes only on the schedule or a dispatch, without any secret', () => {
    const analyze = caller.jobs.analyze!;
    expect(analyze.if).toBe(
      "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}",
    );
    expect(JSON.stringify(analyze)).not.toMatch(/secrets\.|create-github-app-token/);
    expect(analyze.permissions).toEqual({ contents: 'read' });
    expect(
      analyze.steps.some((s) => s.run?.includes('job "$EVENT" --phase analyze') === true),
    ).toBe(true);
  });

  it("acts with the reviewer's token for this repository, never checking out the PR", () => {
    const act = caller.jobs.act!;
    for (const step of act.steps.filter((s) => s.uses?.startsWith('actions/checkout@') === true)) {
      expect(step.with?.repository).toBe('SVP-Labs/Talos');
    }
    const [token] = tokenSteps(act);
    expect(token?.with?.owner).toBeUndefined();
    expect(token?.with?.repositories).toBeUndefined();
    expect(act.if).toMatch(/OWNER.*MEMBER.*COLLABORATOR/s);
    const run = act.steps.at(-1);
    expect(run?.run).toContain('job "$EVENT" --phase act');
    expect(run?.env?.TALOS_REVIEWER_TOKEN).toBe('${{ steps.token.outputs.token }}');
  });

  it('carries the generated marker, so governed repositories never judge it as their own', () => {
    expect(carriesGeneratedMarker(text(FILES.caller))).toBe(true);
  });

  it('acts after analyze, on what it left, with the model only in the act phase', () => {
    const { analyze, act } = caller.jobs;
    expect(needsOf(act!)).toEqual(['analyze']);
    expect(act?.if).toMatch(/^\$\{\{ !cancelled\(\) && \(/);
    const upload = stepIn(analyze, using('actions/upload-artifact'), 'uploading');
    const download = stepIn(act, using('actions/download-artifact'), 'downloading');
    expect(upload.with?.name).toBe('talos-analyze');
    expect(download.with).toEqual({ name: 'talos-analyze', path: upload.with?.path });
    const checkout = stepIn(analyze, (s) => s.with?.path === 'repo', 'checking the branch out');
    expect(checkout.with?.ref).toBe('${{ github.event.repository.default_branch }}');
    expect(JSON.stringify(analyze)).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(stepIn(act, named('Act'), 'Act').env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
      TALOS_OWNER: '${{ vars.TALOS_OWNER }}',
    });
  });

  it("hands the reviewer's model setting to the act phase alone, defaulting nothing", () => {
    const { analyze, act } = caller.jobs;
    const run = stepIn(act, named('Act'), 'Act');
    expect(run.env?.TALOS_REVIEW_MODEL).toBe('${{ vars.TALOS_REVIEW_MODEL }}');
    expect(run.run).not.toMatch(/REVIEW_MODEL/);
    expect(JSON.stringify(analyze)).not.toMatch(/REVIEW_MODEL/);
    const lines = text(FILES.caller)
      .split('\n')
      .filter((line) => line.includes('REVIEW_MODEL'));
    expect(lines.map((line) => line.trim())).toEqual([
      'TALOS_REVIEW_MODEL: ${{ vars.TALOS_REVIEW_MODEL }}',
    ]);
  });

  it('lets one event at a time act on a PR or an issue, cancelling none', () => {
    expect(caller.jobs.act?.concurrency).toEqual({
      group:
        "talos-${{ github.event_name == 'issue_comment' && github.run_id || " +
        'github.event.pull_request.number || github.event.issue.number || github.run_id }}',
      'cancel-in-progress': false,
    });
    expect(caller.jobs.act?.permissions).toEqual({ actions: 'read', contents: 'write' });
  });
});

describe('the central jobs in this public repository', () => {
  it('pass no repository name through an expression: the matrix carries indices', () => {
    for (const path of CENTRAL) {
      const expressions = text(path).match(/\$\{\{[^}]*\}\}/g) ?? [];
      for (const expression of expressions.filter((e) => e.includes('matrix'))) {
        expect(expression, path).toMatch(
          /^\$\{\{ (matrix\.index|fromJSON\(needs\.list\.outputs\.indices\)) \}\}$/,
        );
      }
      for (const [id, job] of jobsOf(path).filter(([, j]) => j.strategy !== undefined)) {
        expect(job.strategy?.matrix, `${path} ${id}`).toEqual({
          index: '${{ fromJSON(needs.list.outputs.indices) }}',
        });
        expect(job.name, `${path} ${id}`).toBe(`${id}-\${{ strategy.job-index }}`);
      }
    }
  });

  it('have Talos look the repository up by index and mask it before minting a token for it', () => {
    const matrixJobs = [FILES.sweep, FILES.drift].flatMap((path) =>
      jobsOf(path).filter(([, j]) => j.strategy !== undefined),
    );
    expect(matrixJobs).toHaveLength(2);
    for (const [id, job] of matrixJobs) {
      const pick = job.steps.findIndex((s) => s.id === 'pick');
      expect(job.steps[pick]?.run, id).toBe(
        'node talos-kit/bootstrap/launch.ts central pick --json',
      );
      expect(job.steps[pick]?.env?.TALOS_INDEX, id).toBe('${{ matrix.index }}');
      const scoped = [...job.steps.entries()].filter(([, s]) => s.with?.repositories !== undefined);
      expect(scoped.length, id).toBeGreaterThan(0);
      for (const [index, step] of scoped) {
        expect(index, id).toBeGreaterThan(pick);
        expect(step.with?.repositories).toBe('${{ steps.pick.outputs.names }}');
      }
      for (const step of job.steps.slice(pick + 1)) {
        expect(step.if, `${id} ${step.name ?? ''}`).toBe("${{ steps.pick.outputs.names != '' }}");
      }
    }
  });

  it('mask names in Talos at the pin, never with a workflow command of their own', () => {
    for (const path of [...Object.values(FILES), 'assets/workflows/talos.yml']) {
      expect(text(path), path).not.toMatch(/::(?:add-mask|stop-commands)::/);
    }
    const maskers = CENTRAL.flatMap((path) =>
      jobsOf(path).flatMap(([id, job]) =>
        job.steps.flatMap((step, index) =>
          /^node talos-kit\/bootstrap\/launch\.ts central (?:pick|privacy --mask)\b/.test(
            step.run ?? '',
          )
            ? [{ where: `${path} ${id}`, job, index }]
            : [],
        ),
      ),
    );
    expect(maskers).toHaveLength(6);
    for (const { where, job, index } of maskers) {
      const kit = job.steps.findIndex((s) => s.with?.path === 'talos-kit');
      expect(kit, where).toBeGreaterThan(-1);
      expect(kit, where).toBeLessThan(index);
    }
  });

  it("mint no token that reaches every repository of an App's installation", () => {
    for (const path of Object.values(FILES)) {
      for (const [id, job] of jobsOf(path)) {
        for (const step of tokenSteps(job).filter(
          (s) => s.with?.owner !== undefined && s.with.repositories === undefined,
        )) {
          const asked = Object.keys(step.with ?? {}).filter((k) => k.startsWith('permission-'));
          expect(
            asked.every((k) => k.startsWith('permission-organization-')),
            `${path} ${id} ${step.name ?? ''}`,
          ).toBe(true);
        }
      }
    }
  });

  it('name repositories in a token only from an earlier step that masked them, and never none', () => {
    const scoped = CENTRAL.flatMap((path) =>
      jobsOf(path).flatMap(([id, job]) =>
        [...job.steps.entries()].flatMap(([index, step]) => {
          const named = step.with?.repositories;
          return named === undefined ? [] : [{ where: `${path} ${id}`, job, index, step, named }];
        }),
      ),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const { where, job, index, step, named } of scoped) {
      const from = /^\$\{\{ steps\.(\w+)\.outputs\.\w+ \}\}$/.exec(
        typeof named === 'string' ? named : '',
      );
      const producer = job.steps.findIndex((s) => s.id === from?.[1]);
      expect(producer, where).toBeGreaterThan(-1);
      expect(producer, where).toBeLessThan(index);
      expect(job.steps[producer]?.run, where).toMatch(/ central (?:pick|privacy --mask)\b/);
      expect(step.if, where).toContain(`steps.${from?.[1] ?? ''}.outputs.`);
    }
  });

  it('prove each App reaches the canary with a token minted for the canary alone', () => {
    const apps: Readonly<Record<string, readonly string[]>> = {
      [FILES.channels]: ['release'],
      [FILES.sweep]: ['reviewer'],
      [FILES.drift]: ['release', 'reviewer'],
    };
    for (const path of CENTRAL) {
      const privacy = workflow(path).jobs.privacy!;
      const mask = stepIn(privacy, named('canary'), 'masking the names');
      expect(mask.run, path).toBe(
        'node talos-kit/bootstrap/launch.ts central privacy --mask --json',
      );
      const search = privacy.steps.at(-1);
      expect(search?.env?.TALOS_PROPERTIES_TOKEN, path).toBe(mask.env?.TALOS_PROPERTIES_TOKEN);
      for (const app of apps[path] ?? []) {
        const token = stepIn(privacy, named(app), `minting ${app}'s token`);
        expect(token.with?.repositories, path).toBe('${{ steps.canary.outputs.name }}');
        expect(search?.env?.[`TALOS_${app.toUpperCase()}_TOKEN`], path).toBe(
          `\${{ steps.${app}.outputs.token }}`,
        );
      }
    }
  });

  it('end with a privacy self-test that waits for every other job', () => {
    for (const path of CENTRAL) {
      const jobs = jobsOf(path);
      const privacy = workflow(path).jobs.privacy!;
      expect(privacy.if, path).toContain('!cancelled()');
      expect(new Set(needsOf(privacy)), path).toEqual(
        new Set(jobs.map(([id]) => id).filter((id) => id !== 'privacy')),
      );
      const run = privacy.steps.at(-1);
      expect(run?.run, path).toBe('node talos-kit/bootstrap/launch.ts central privacy --json');
      expect(run?.env?.TALOS_PRIVACY_JOB, path).toBe(privacy.name);
    }
  });

  it("use talos-release's key only in the main-only release environment", () => {
    for (const path of [...CENTRAL, FILES.caller, FILES.gate, FILES.release, FILES.selfTest]) {
      for (const [id, job] of jobsOf(path)) {
        if (JSON.stringify(job).includes('TALOS_RELEASE_KEY')) {
          expect(job.environment, `${path} ${id}`).toBe('release');
        }
      }
    }
  });

  it('print JSON only', () => {
    for (const path of CENTRAL) {
      for (const step of stepsOf(path).filter(
        (s) => s.run?.includes('launch.ts central') === true,
      )) {
        expect(step.run, path).toMatch(/ --json$/);
      }
    }
  });
});

describe('the release and channel workflows', () => {
  it('publish from a v* tag, the OIDC permission on a job that runs no dependency', () => {
    const release = workflow(FILES.release);
    expect(release.on).toEqual({ push: { tags: ['v*'] } });
    expect(release.jobs.build?.permissions).toEqual({ contents: 'read' });
    expect(release.jobs.publish?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const publish = JSON.stringify(release.jobs.publish);
    expect(publish).not.toMatch(/pnpm|npm install|NPM_TOKEN|NODE_AUTH_TOKEN/);
    expect(publish).toContain('npm publish');
    expect(publish).toContain('--provenance');
    expect(text(FILES.release)).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main',
    );
  });

  it('move pins hourly, on a regression and on the owner’s dispatch, from main only', () => {
    const channels = workflow(FILES.channels);
    expect(channels.on).toEqual({
      schedule: [{ cron: '23 * * * *' }],
      workflow_dispatch: null,
      issues: { types: ['opened', 'labeled'] },
    });
    const job = channels.jobs.channels!;
    expect(job.environment).toBe('release');
    expect(job.if).toContain("github.event.label.name == 'regression'");
    expect(job.steps[0]?.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(job.steps.at(-1)?.run).toBe(
      'node talos-kit/bootstrap/launch.ts central channels --json',
    );
  });

  it('test the PR’s own engine on every OS', () => {
    const selfTest = workflow(FILES.selfTest);
    expect(selfTest.on).toEqual({ pull_request: null, push: { branches: ['main'] } });
    const runs = stepsOf(FILES.selfTest).map((s) => s.run ?? '');
    expect(runs).toContain('pnpm check');
    expect(runs).toContain('node dist/bin/talos.js self-test test-projects');
    expect(JSON.stringify(selfTest.jobs['self-test']?.strategy?.matrix)).toMatch(
      /ubuntu.*windows.*macos/,
    );
  });
});

const exec = promisify(execFile);

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await exec(command, args, { env });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    return {
      code: typeof failure.code === 'number' ? failure.code : 127,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
    };
  }
}

const canRunScripts =
  (await run('bash', ['--version'], process.env)).code === 0 &&
  (await run('jq', ['--version'], process.env)).code === 0;

/** `gh api [--paginate] <path>` answered from files; an unknown path fails as `gh` does. */
function fakeGh(answers: Readonly<Record<string, unknown>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'talos-central-gh-'));
  const answersDir = join(directory, 'answers');
  mkdirSync(answersDir);
  for (const [path, body] of Object.entries(answers)) {
    const content = typeof body === 'string' ? body : JSON.stringify(body);
    writeFileSync(join(answersDir, path.replaceAll(/[/?=&]/g, '_')), content);
  }
  const script = [
    '#!/usr/bin/env bash',
    'path=""',
    'for arg in "$@"; do case "$arg" in api|--paginate) ;; *) path="$arg" ;; esac; done',
    `file="${answersDir}/$(printf '%s' "$path" | tr '/?=&' '____')"`,
    '[ -f "$file" ] || { echo "HTTP 404: $path (SVP-Labs/Secret)" >&2; exit 1; }',
    'cat "$file"',
  ].join('\n');
  writeFileSync(join(directory, 'gh'), `${script}\n`);
  chmodSync(join(directory, 'gh'), 0o755);
  return directory;
}

function scriptOf(path: string, stepName: string): string {
  const step = stepsOf(path).find((s) => s.name === stepName);
  if (step?.run === undefined) throw new Error(`no step "${stepName}" in ${path}`);
  return step.run;
}

async function runStep(
  script: string,
  answers: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>>,
): Promise<{ code: number; stdout: string; output: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'talos-central-step-'));
  const file = join(directory, 'step.sh');
  const output = join(directory, 'output');
  writeFileSync(file, script);
  writeFileSync(output, '');
  const result = await run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
    PATH: `${fakeGh(answers)}${delimiter}${process.env.PATH ?? ''}`,
    GITHUB_OUTPUT: output,
    ...env,
  });
  return { ...result, output: readFileSync(output, 'utf8') };
}

/** The organisation's custom property listing, as `orgs/{org}/properties/values` pages it. */
const listing = (repos: { id: number; full_name: string; talos?: string }[]) =>
  repos.map((repo) => ({
    repository_id: repo.id,
    repository_name: repo.full_name.split('/')[1],
    repository_full_name: repo.full_name,
    properties: repo.talos === undefined ? [] : [{ property_name: 'talos', value: repo.talos }],
  }));

describe.skipIf(!canRunScripts)('the inline lookup scripts', () => {
  const PROPERTIES = 'orgs/SVP-Labs/properties/values?per_page=100';
  const ORG = { ORG: 'SVP-Labs' };
  const repos: { id: number; full_name: string; talos?: string }[] = [
    { id: 30, full_name: 'SVP-Labs/Zeta', talos: 'stable' },
    { id: 10, full_name: 'SVP-Labs/Secret', talos: 'canary' },
    { id: 15, full_name: 'SVP-Labs/Ungoverned' },
    { id: 25, full_name: 'SVP-Labs/Paused', talos: 'off' },
    { id: 20, full_name: 'SVP-Labs/Other', talos: 'evaluate' },
  ];
  const pages = [listing(repos.slice(0, 4)), listing(repos.slice(4))]
    .map((page) => JSON.stringify(page))
    .join('\n');

  it('counts the governed repositories into a matrix of indices, printing only the count', async () => {
    const count = scriptOf(FILES.sweep, 'Count the repositories');
    const result = await runStep(count, { [PROPERTIES]: pages }, ORG);
    expect(result).toEqual({ code: 0, stdout: 'repositories: 3\n', output: 'indices=[0,1,2]\n' });
    const none = await runStep(
      count,
      { [PROPERTIES]: listing([{ id: 1, full_name: 'o/a' }]) },
      ORG,
    );
    expect(none.output).toBe('indices=[]\n');
    const many = listing(
      Array.from({ length: 300 }, (_, id) => ({ id, full_name: `o/r${id}`, talos: 'stable' })),
    );
    expect((await runStep(count, { [PROPERTIES]: many }, ORG)).code).toBe(1);
    expect((await runStep(count, {}, ORG)).code).toBe(1);
    expect(scriptOf(FILES.drift, 'Count the repositories')).toBe(count);
  });

  it('counts the indices Talos picks from, each naming one repository and none past the last', async () => {
    const count = scriptOf(FILES.sweep, 'Count the repositories');
    const counted = await runStep(count, { [PROPERTIES]: pages }, ORG);
    const indices = z.array(z.number()).parse(JSON.parse(counted.output.slice('indices='.length)));
    const fake = fakeGitHub({
      [propertiesPath('SVP-Labs')]: propertyValues(
        repos.map(({ id, full_name: name, talos }) =>
          talos === undefined ? { id, name } : { id, name, talos },
        ),
      ),
    });
    const picked: string[] = [];
    for (const index of [...indices, indices.length]) {
      await pickRepositories({
        properties: fake.gh,
        org: 'SVP-Labs',
        index: String(index),
        out: () => undefined,
        output: (_, names) => {
          picked.push(names);
          return Promise.resolve();
        },
      });
    }
    expect(picked).toEqual(['Secret', 'Other', 'Zeta', '']);
  });

  it("finds stable's pin in the org rulesets or channels.json", async () => {
    const find = scriptOf(FILES.channels, "Find stable's pin");
    const A = 'a'.repeat(40);
    const rule = (sha: string) => ({
      rules: [{ type: 'workflows', parameters: { workflows: [{ repository_id: 1, sha }] } }],
    });
    const rulesets = {
      'orgs/SVP-Labs/rulesets': [
        { id: 4, name: 'talos-canary' },
        { id: 5, name: 'talos-stable' },
      ],
      'orgs/SVP-Labs/rulesets/5': rule(A),
    };
    expect(await runStep(find, rulesets, { ORG: 'SVP-Labs' })).toEqual({
      code: 0,
      stdout: '',
      output: `sha=${A}\n`,
    });
    const unpinned = await runStep(
      find,
      { ...rulesets, 'orgs/SVP-Labs/rulesets/5': rule('v1') },
      { ORG: 'SVP-Labs' },
    );
    expect(unpinned.code).toBe(1);
    const channels = {
      'repos/SVP-Labs/Talos/contents/channels.json?ref=channels': {
        content: Buffer.from(JSON.stringify({ evaluate: A, canary: A, stable: A })).toString(
          'base64',
        ),
      },
    };
    const env = {
      TALOS_LOOKUP: 'channels',
      GITHUB_REPOSITORY: 'SVP-Labs/Talos',
      WORKFLOW_TOKEN: 'w',
    };
    expect((await runStep(find, channels, env)).output).toBe(`sha=${A}\n`);
  });
});

const canRunPhpScript =
  canRunScripts &&
  (await run('git', ['--version'], process.env)).code === 0 &&
  (await run('yq', ['--version'], process.env)).code === 0;

describe.skipIf(!canRunPhpScript)('bootstrap/php.sh', () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await exec('git', args, { cwd })).stdout.trim();

  async function commit(cwd: string, files: Readonly<Record<string, string>>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(cwd, path, '..'), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    await git(cwd, 'add', '-A');
    await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
    return git(cwd, 'rev-parse', 'HEAD');
  }

  async function php(cwd: string, ...commits: string[]): Promise<{ code: number; stdout: string }> {
    const script = new URL('bootstrap/php.sh', ROOT).pathname;
    try {
      const { stdout } = await exec('bash', [script, ...commits], { cwd });
      return { code: 0, stdout };
    } catch (error) {
      const failure = error as { code?: unknown };
      return { code: typeof failure.code === 'number' ? failure.code : 127, stdout: '' };
    }
  }

  it('names the OSes of every PHP component at either commit, and the newest PHP asked', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'talos-php-'));
    await git(cwd, 'init', '-q');
    const none = await commit(cwd, {
      'talos.yml': 'name: A\nprefix: A\ncomponents:\n  - { lang: ts, root: . }\n',
    });
    expect(await php(cwd, none)).toEqual({ code: 0, stdout: 'oses=[]\nversion=8.4\n' });
    const both = await commit(cwd, {
      'talos.yml': [
        'name: A',
        'prefix: A',
        'components:',
        '  - { lang: php, root: ./api/, os: [windows, linux] }',
        '  - lang: php',
        '    root: .',
        '',
      ].join('\n'),
      'api/composer.json': JSON.stringify({ require: { php: '^8.5' } }),
      'composer.json': JSON.stringify({ config: { platform: { php: '8.3.1' } } }),
    });
    expect(await php(cwd, none, both)).toEqual({
      code: 0,
      stdout: 'oses=["linux","windows"]\nversion=8.5\n',
    });
    const old = await commit(cwd, {
      'api/composer.json': JSON.stringify({ require: { php: '>=8.1' } }),
    });
    expect((await php(cwd, old)).stdout).toBe('oses=["linux","windows"]\nversion=8.4\n');
  });

  it('fails without a commit, or on a talos.yml that is not YAML', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'talos-php-'));
    await git(cwd, 'init', '-q');
    const broken = await commit(cwd, { 'talos.yml': 'name: [\n' });
    expect((await php(cwd)).code).toBe(1);
    expect((await php(cwd, broken)).code).toBe(1);
  });
});

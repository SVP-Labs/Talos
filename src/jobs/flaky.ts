import { z } from 'zod';
import { recentArtifacts } from './artifacts.js';
import { nameable } from './debt-issues.js';
import {
  codeSpan,
  digest,
  fileIssue,
  type IssueDraft,
  marker,
  type TalosIssue,
  talosIssues,
} from './talos-issues.js';
import type { GitHub } from '../github/api.js';
import { type Download, extractFile } from '../github/artifacts.js';
import { queueGateRuns } from '../github/gate-runs.js';
import type { Identities } from '../github/identities.js';
import { fileAt } from '../ticket/github.js';
import { LABEL } from '../ticket/labels.js';
import { clip } from '../ticket/payload.js';

/** The gate uploads its compact verdict as this artifact, holding `verdict.json`. */
const VERDICT_ARTIFACT = 'talos-verdict';

/** How far back each daily run looks; a run that failed one day is covered the next. */
const SEEN_WITHIN_DAYS = 2;

const MAX_ARTIFACTS = 50;
const MAX_NEW = 5;
const MAX_VERDICT_BYTES = 1024 * 1024;

const verdictFlaky = z.object({
  schema: z.literal('talos.verdict/1'),
  pr: z.number().int().nullable().optional(),
  flaky: z
    .array(z.object({ id: z.string().min(1).max(1000), file: z.string().nullable() }))
    .max(1000),
});

export type FlakySighting = {
  readonly id: string;
  readonly file: string | null;
  readonly seenAt: string;
  readonly pr: number | null;
};

/** The flaky tests one `verdict.json` reports; anything else in it is ignored. */
export function flakyIn(text: string, seenAt: string): FlakySighting[] {
  const verdict = verdictFlaky.parse(JSON.parse(text));
  return verdict.flaky.map((f) => ({ id: f.id, file: f.file, seenAt, pr: verdict.pr ?? null }));
}

export type FlakyCandidate = FlakySighting & { readonly file: string; readonly digest: string };

/** One candidate per test, from its latest sighting; a test without a file can't be named. */
export function flakyCandidates(sightings: readonly FlakySighting[]): FlakyCandidate[] {
  const latest = new Map<string, FlakyCandidate>();
  for (const s of sightings) {
    if (s.file === null || !nameable(s.file)) continue;
    const known = latest.get(s.id);
    if (known !== undefined && Date.parse(known.seenAt) >= Date.parse(s.seenAt)) continue;
    latest.set(s.id, { ...s, file: s.file, digest: digest(s.id) });
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Tests with no open issue. A test whose issue was closed after the sighting was fixed since;
 * one seen flaking after its issue closed gets a new one.
 */
export function unfiled(
  candidates: readonly FlakyCandidate[],
  existing: readonly TalosIssue[],
): FlakyCandidate[] {
  const open = new Set(existing.filter((i) => i.state === 'open').map((i) => i.fields.test));
  const closed = new Map<string, number>();
  for (const issue of existing) {
    const test = issue.fields.test;
    if (issue.state !== 'closed' || test === undefined || issue.closedAt === undefined) continue;
    closed.set(test, Math.max(closed.get(test) ?? 0, Date.parse(issue.closedAt)));
  }
  return candidates.filter(
    (c) => !open.has(c.digest) && (closed.get(c.digest) ?? 0) < Date.parse(c.seenAt),
  );
}

export function flakyIssue(c: FlakyCandidate): IssueDraft {
  const test = codeSpan(c.id);
  const where = c.pr === null ? '' : ` (on PR #${c.pr})`;
  const body = [
    marker('flaky', { test: c.digest, file: c.file }),
    '',
    '### Goal',
    '',
    `Make ${test} pass reliably, so the gate no longer has to let it through as flaky.`,
    '',
    '### Repro',
    '',
    `Run the tests of \`${c.file}\` repeatedly: the gate saw this test fail and then pass on ` +
      `its immediate rerun, last on ${c.seenAt.slice(0, 10)}${where}.`,
    '',
    '### Expected / Actual',
    '',
    'Expected: it passes every time. Actual: it sometimes fails, and passes when run again.',
    '',
    '### Acceptance criteria',
    '',
    '- [ ] The cause is found and fixed, not hidden behind a retry, a longer timeout or a skip',
    '- [ ] The test still asserts everything it asserted before',
    '',
    '### Out of scope',
    '',
    'Other tests, and the rerun policy itself.',
    '',
    '### Affected areas',
    '',
    `- \`${c.file}\``,
    '- the code under test, where the cause lies',
    '',
  ].join('\n');
  return {
    title: `Flaky test: ${clip(c.id, 80)}`,
    body,
    labels: [LABEL.bug, LABEL.flaky, LABEL.ready, LABEL.eligible, LABEL.p2],
  };
}

export type FlakyDeps = {
  readonly gh: GitHub;
  /** The workflow's own token, which reads the gate's artifacts. */
  readonly actions: GitHub;
  readonly download: Download;
};

/**
 * The flaky tests the gate saw in the merge queue lately. Only there has review passed the code
 * whose test names a sighting carries, and only the gate's own runs count: any workflow can
 * upload an artifact by the gate's name.
 */
async function sightings(
  deps: FlakyDeps,
  at: { readonly repo: string; readonly talosRepo: string; readonly now: Date },
): Promise<{ found: FlakySighting[]; unreadable: number }> {
  const since = new Date(at.now.getTime() - SEEN_WITHIN_DAYS * 86_400_000);
  const gate = new Set(
    (await queueGateRuns(deps.actions, at.repo, { since, talosRepo: at.talosRepo })).map(
      (r) => r.id,
    ),
  );
  if (gate.size === 0) return { found: [], unreadable: 0 };
  const artifacts = (
    await recentArtifacts(deps.actions, at.repo, {
      name: VERDICT_ARTIFACT,
      since,
      max: MAX_ARTIFACTS,
    })
  ).filter((artifact) => artifact.runId !== undefined && gate.has(artifact.runId));
  const found: FlakySighting[] = [];
  let unreadable = 0;
  for (const artifact of artifacts) {
    try {
      const text = extractFile(
        await deps.download(artifact.url),
        'verdict.json',
        MAX_VERDICT_BYTES,
      );
      if (text !== undefined) found.push(...flakyIn(text, artifact.createdAt));
    } catch {
      unreadable += 1;
    }
  }
  return { found, unreadable };
}

/**
 * Files one issue per flaky test the gate reported recently in the merge queue, for tests still
 * on the default branch, at most five a day.
 */
export async function fileFlakyIssues(
  deps: FlakyDeps,
  at: {
    readonly repo: string;
    readonly who: Identities;
    readonly now: Date;
    readonly base: string;
  },
): Promise<{ filed: number; seen: number; unreadable: number }> {
  const { found, unreadable } = await sightings(deps, {
    repo: at.repo,
    talosRepo: at.who.talosRepo,
    now: at.now,
  });
  const candidates = flakyCandidates(found);
  if (candidates.length === 0) return { filed: 0, seen: 0, unreadable };
  const fresh = unfiled(candidates, await talosIssues(deps.gh, at, LABEL.flaky, 'flaky'));
  let filed = 0;
  for (const candidate of fresh) {
    if (filed >= MAX_NEW) break;
    if ((await fileAt(deps.gh, at.repo, candidate.file, at.base)) === undefined) continue;
    await fileIssue(deps.gh, at.repo, flakyIssue(candidate));
    filed += 1;
  }
  return { filed, seen: candidates.length, unreadable };
}

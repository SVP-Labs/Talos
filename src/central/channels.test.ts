import { describe, expect, it } from 'vitest';
import {
  afterMoves,
  canaryTarget,
  dispatchAllowed,
  gateJobNames,
  heldBack,
  type Pins,
  pinMoves,
  promotion,
  type PromotionInput,
  promotionMoves,
  reachedAt,
  type Regression,
  type RegressionIssue,
  regressionOf,
  type Release,
  releaseAt,
  releasesOf,
  tallyJobs,
  worthCounting,
  worthDating,
} from './channels.js';

const sha = (n: number): string => n.toString(16).padStart(40, '0');

function release(version: string, n: number, taggedAt: string): Release {
  return { tag: `v${version}`, version, sha: sha(n), taggedAt };
}

const v1 = release('1.0.0', 1, '2026-10-01T00:00:00Z');
const v2 = release('1.1.0', 2, '2026-10-08T00:00:00Z');
const v3 = release('1.2.0', 3, '2026-10-15T00:00:00Z');
/** Newest first, as `releasesOf` orders them. */
const RELEASES = [v3, v2, v1];

function regression(reportedAt: string, extra: Partial<Regression> = {}): Regression {
  return { number: 1, open: true, dismissed: false, reportedAt, ...extra };
}

describe('releasesOf', () => {
  it('keeps plain vX.Y.Z tags, newest version first', () => {
    const tags = [
      { name: 'v1.2.0', sha: sha(3), taggedAt: 't3' },
      { name: 'v1.10.0', sha: sha(4), taggedAt: 't4' },
      { name: 'v1.2.0-rc.1', sha: sha(5), taggedAt: 't5' },
      { name: 'release-1', sha: sha(6), taggedAt: 't6' },
      { name: 'v01.2.3', sha: sha(7), taggedAt: 't7' },
      { name: 'v1.9.9', sha: sha(8), taggedAt: 't8' },
    ];
    expect(releasesOf(tags).map((r) => r.tag)).toEqual(['v1.10.0', 'v1.9.9', 'v1.2.0']);
    expect(releasesOf(tags)[0]).toEqual({
      tag: 'v1.10.0',
      version: '1.10.0',
      sha: sha(4),
      taggedAt: 't4',
    });
  });

  it('finds a release by its commit', () => {
    expect(releaseAt(RELEASES, sha(2))).toBe(v2);
    expect(releaseAt(RELEASES, sha(9))).toBeUndefined();
    expect(releaseAt(RELEASES, undefined)).toBeUndefined();
  });
});

describe('regressionOf', () => {
  const TRUSTED = ['SvenPGH', 'thea-svp[bot]', 'talos-reviewer[bot]', 'talos-release[bot]'];
  const issue = (extra: Partial<RegressionIssue>): RegressionIssue => ({
    number: 7,
    author: 'stranger',
    open: true,
    stateReason: undefined,
    labels: ['regression'],
    createdAt: '2026-10-10T00:00:00Z',
    labelled: [],
    ...extra,
  });

  it('counts an issue a trusted actor labelled, from the earliest trusted label', () => {
    const labelled = [
      { label: 'regression', actor: 'stranger', at: '2026-10-10T01:00:00Z' },
      { label: 'regression', actor: 'thea-svp[bot]', at: '2026-10-10T03:00:00Z' },
      { label: 'regression', actor: 'SvenPGH'.toLowerCase(), at: '2026-10-10T02:00:00Z' },
      { label: 'bug', actor: 'SvenPGH', at: '2026-10-10T00:30:00Z' },
    ];
    expect(regressionOf(issue({ labelled }), TRUSTED)).toEqual({
      number: 7,
      open: true,
      dismissed: false,
      reportedAt: '2026-10-10T02:00:00Z',
    });
  });

  it("counts any regression label on an issue a trusted actor opened, else the issue's date", () => {
    const labelled = [{ label: 'regression', actor: 'collaborator', at: '2026-10-11T00:00:00Z' }];
    expect(regressionOf(issue({ author: 'SvenPGH', labelled }), TRUSTED)?.reportedAt).toBe(
      '2026-10-11T00:00:00Z',
    );
    expect(regressionOf(issue({ author: 'talos-release[bot]' }), TRUSTED)?.reportedAt).toBe(
      '2026-10-10T00:00:00Z',
    );
  });

  it('ignores a stranger, an unlabelled issue and an unknown actor', () => {
    const labelled = [{ label: 'regression', actor: undefined, at: '2026-10-11T00:00:00Z' }];
    expect(regressionOf(issue({ labelled }), TRUSTED)).toBeUndefined();
    expect(regressionOf(issue({ author: undefined, labelled }), TRUSTED)).toBeUndefined();
    expect(regressionOf(issue({ author: 'SvenPGH', labels: ['bug'] }), TRUSTED)).toBeUndefined();
  });

  it('marks an issue closed as not planned as dismissed, and only that', () => {
    const owner = { author: 'SvenPGH' };
    const notPlanned = issue({ ...owner, open: false, stateReason: 'not_planned' });
    const completed = issue({ ...owner, open: false, stateReason: 'completed' });
    expect(regressionOf(notPlanned, TRUSTED)).toMatchObject({ open: false, dismissed: true });
    expect(regressionOf(completed, TRUSTED)).toMatchObject({ open: false, dismissed: false });
  });
});

describe('heldBack and canaryTarget', () => {
  it('takes the newest release when nothing was reported', () => {
    expect(canaryTarget(RELEASES, [])).toBe(v3);
    expect(canaryTarget([], [])).toBeUndefined();
  });

  it('rolls back from the release that was newest when the regression was reported', () => {
    const report = regression('2026-10-16T00:00:00Z');
    expect([...heldBack(RELEASES, [report])]).toEqual(['v1.2.0']);
    expect(canaryTarget(RELEASES, [report])).toBe(v2);
  });

  it('is idempotent: a second report of the same release rolls back no further', () => {
    const reports = [regression('2026-10-16T00:00:00Z'), regression('2026-10-17T00:00:00Z')];
    expect(canaryTarget(RELEASES, reports)).toBe(v2);
  });

  it('keeps the bad release back after its report is closed as fixed, until a newer one', () => {
    const fixed = regression('2026-10-16T00:00:00Z', { open: false });
    expect(canaryTarget(RELEASES, [fixed])).toBe(v2);
    const v4 = release('1.3.0', 4, '2026-10-18T00:00:00Z');
    expect(canaryTarget([v4, ...RELEASES], [fixed])).toBe(v4);
  });

  it('lets a false alarm go: a dismissed report holds nothing back', () => {
    const dismissed = regression('2026-10-16T00:00:00Z', { open: false, dismissed: true });
    expect(canaryTarget(RELEASES, [dismissed])).toBe(v3);
  });

  it('holds back each culprit of several reports, and nothing for a report before any release', () => {
    const reports = [regression('2026-10-09T00:00:00Z'), regression('2026-10-16T00:00:00Z')];
    expect(canaryTarget(RELEASES, reports)).toBe(v1);
    expect([...heldBack(RELEASES, [regression('2026-09-01T00:00:00Z')])]).toEqual([]);
    const everything = [...reports, regression('2026-10-02T00:00:00Z')];
    expect(canaryTarget(RELEASES, everything)).toBeUndefined();
  });
});

describe('pinMoves', () => {
  const pins = (canary?: number, stable?: number, evaluate?: number): Pins => ({
    canary: canary === undefined ? undefined : sha(canary),
    stable: stable === undefined ? undefined : sha(stable),
    evaluate: evaluate === undefined ? undefined : sha(evaluate),
  });

  it('seeds every pin from the first release', () => {
    expect(pinMoves(pins(), [v1], [])).toEqual([
      { channel: 'canary', from: undefined, to: v1 },
      { channel: 'stable', from: undefined, to: v1 },
      { channel: 'evaluate', from: undefined, to: v1 },
    ]);
  });

  it('moves canary to the newest release and leaves stable alone', () => {
    expect(pinMoves(pins(2, 1, 1), RELEASES, [])).toEqual([
      { channel: 'canary', from: sha(2), to: v3 },
    ]);
  });

  it('keeps evaluate on stable', () => {
    expect(pinMoves(pins(3, 2, 1), RELEASES, [])).toEqual([
      { channel: 'evaluate', from: sha(1), to: v2 },
    ]);
    expect(pinMoves(pins(3, 2, 2), RELEASES, [])).toEqual([]);
  });

  it('moves canary back on a regression', () => {
    const report = regression('2026-10-16T00:00:00Z');
    expect(pinMoves(pins(3, 1, 1), RELEASES, [report])).toEqual([
      { channel: 'canary', from: sha(3), to: v2 },
    ]);
  });

  it('does nothing without a release, and leaves evaluate when stable pins no release', () => {
    expect(pinMoves(pins(), [], [])).toEqual([]);
    expect(pinMoves(pins(3, 9, 1), RELEASES, [])).toEqual([]);
  });

  it('applies moves in order', () => {
    const moves = pinMoves(pins(), [v1], []);
    expect(afterMoves(pins(), moves)).toEqual(pins(1, 1, 1));
  });
});

describe('the gate tally', () => {
  it('names the jobs after the release', () => {
    expect(gateJobNames('1.2.0')).toEqual({
      verdict: 'verdict (talos 1.2.0)',
      engine: 'engine (talos 1.2.0)',
    });
  });

  it('counts finished verdicts and failed engine jobs of that release only', () => {
    const job = (name: string, conclusion: string | null) => ({
      name,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
    });
    const jobs = [
      job('verdict (talos 1.2.0)', 'success'),
      job('verdict (talos 1.2.0)', 'failure'),
      job('verdict (talos 1.2.0)', 'skipped'),
      job('verdict (talos 1.2.0)', 'cancelled'),
      job('verdict (talos 1.2.0)', null),
      job('verdict (talos 1.1.0)', 'success'),
      job('engine (talos 1.2.0)', 'success'),
      job('engine (talos 1.2.0)', 'failure'),
      job('engine (talos 1.1.0)', 'failure'),
      job('run linux commit,head abc', 'failure'),
    ];
    expect(tallyJobs(jobs, '1.2.0')).toEqual({ runs: 2, engineErrors: 1 });
  });
});

describe('promotion', () => {
  const NOW = new Date('2026-10-23T12:00:00Z');
  const base: PromotionInput = {
    canary: v3,
    stable: v2,
    regressionOpen: false,
    urgent: false,
    now: NOW,
    reachedAt: '2026-10-16T00:00:00Z',
    tally: { runs: 5, engineErrors: 0 },
  };

  it('promotes after seven days with five clean gate runs', () => {
    expect(promotion(base)).toEqual({ promote: true, release: v3 });
  });

  it('holds for each unmet condition, cheapest first', () => {
    const cases: [Partial<PromotionInput>, string][] = [
      [{ canary: undefined }, 'no-release'],
      [{ stable: v3 }, 'not-newer'],
      [{ canary: v1 }, 'not-newer'],
      [{ regressionOpen: true }, 'regression-open'],
      [{ reachedAt: undefined }, 'age-unknown'],
      [{ reachedAt: 'not a date' }, 'age-unknown'],
      [{ reachedAt: '2026-10-17T00:00:00Z' }, 'too-young'],
      [{ tally: undefined }, 'tally-unknown'],
      [{ tally: { runs: 50, engineErrors: 1 } }, 'engine-error'],
      [{ tally: { runs: 4, engineErrors: 0 } }, 'too-few-runs'],
    ];
    for (const [change, reason] of cases) {
      expect(promotion({ ...base, ...change })).toEqual({ promote: false, hold: reason });
    }
  });

  it('counts the seven days to the millisecond', () => {
    expect(promotion({ ...base, reachedAt: '2026-10-16T12:00:00Z' }).promote).toBe(true);
    expect(promotion({ ...base, reachedAt: '2026-10-16T12:00:00.001Z' }).promote).toBe(false);
  });

  it('promotes the first release onto an empty stable', () => {
    expect(promotion({ ...base, stable: undefined })).toEqual({ promote: true, release: v3 });
  });

  it('on the urgent path, needs one clean gate run and no wait', () => {
    const urgent = { ...base, urgent: true, reachedAt: undefined };
    expect(promotion({ ...urgent, tally: { runs: 1, engineErrors: 0 } }).promote).toBe(true);
    expect(promotion({ ...urgent, tally: { runs: 0, engineErrors: 0 } })).toEqual({
      promote: false,
      hold: 'too-few-runs',
    });
    expect(promotion({ ...urgent, tally: { runs: 3, engineErrors: 1 } })).toEqual({
      promote: false,
      hold: 'engine-error',
    });
    expect(promotion({ ...urgent, regressionOpen: true })).toEqual({
      promote: false,
      hold: 'regression-open',
    });
  });

  it('says when reading the age is worth it', () => {
    expect(worthDating({ ...base, reachedAt: undefined })).toBe(true);
    expect(worthDating({ ...base, urgent: true })).toBe(false);
    expect(worthDating({ ...base, regressionOpen: true })).toBe(false);
  });

  it('says when counting gate runs is worth it', () => {
    expect(worthCounting({ ...base, tally: undefined })).toBe(true);
    expect(worthCounting({ ...base, reachedAt: '2026-10-20T00:00:00Z' })).toBe(false);
    expect(worthCounting({ ...base, urgent: true, reachedAt: undefined })).toBe(true);
  });

  it('moves stable and evaluate, skipping one already there', () => {
    expect(promotionMoves({ canary: v3.sha, stable: v2.sha, evaluate: v2.sha }, v3)).toEqual([
      { channel: 'stable', from: v2.sha, to: v3 },
      { channel: 'evaluate', from: v2.sha, to: v3 },
    ]);
    expect(promotionMoves({ canary: v3.sha, stable: v2.sha, evaluate: v3.sha }, v3)).toEqual([
      { channel: 'stable', from: v2.sha, to: v3 },
    ]);
  });
});

describe('reachedAt', () => {
  it('is the oldest of the newest run of versions pinning the release', () => {
    const versions = [
      { at: '2026-10-20T00:00:00Z', sha: sha(3) },
      { at: '2026-10-16T00:00:00Z', sha: sha(3) },
      { at: '2026-10-15T00:00:00Z', sha: sha(2) },
      { at: '2026-10-01T00:00:00Z', sha: sha(3) },
    ];
    expect(reachedAt(versions, sha(3))).toBe('2026-10-16T00:00:00Z');
    expect(reachedAt(versions, sha(2))).toBeUndefined();
    expect(reachedAt([], sha(3))).toBeUndefined();
  });
});

describe('dispatchAllowed', () => {
  it('lets only the owner dispatch and rerun, without regard to case', () => {
    expect(
      dispatchAllowed({ actor: 'SvenPGH'.toUpperCase(), triggering: undefined }, 'SvenPGH'),
    ).toBe(true);
    expect(dispatchAllowed({ actor: 'SvenPGH', triggering: 'SvenPGH' }, 'SvenPGH')).toBe(true);
    expect(dispatchAllowed({ actor: 'SvenPGH', triggering: 'thea-svp[bot]' }, 'SvenPGH')).toBe(
      false,
    );
    expect(dispatchAllowed({ actor: 'someone', triggering: 'SvenPGH' }, 'SvenPGH')).toBe(false);
    expect(dispatchAllowed({ actor: undefined, triggering: undefined }, 'SvenPGH')).toBe(false);
  });
});

import type { IssueDraft } from '../jobs/talos-issues.js';
import { LABEL } from '../ticket/labels.js';

/**
 * The weekly drift report's decisions: what a governed repository should have, how it differs,
 * and the one issue per difference. The expectations are written here from what `talos govern`
 * sets (the caller and CODEOWNERS, the merge-queue and owner-review rulesets, the merge settings,
 * the creation restriction, Dependabot alerts, the channel property); `govern` keeps its own
 * copy, and the two must change together.
 */

export const CALLER_PATH = '.github/workflows/talos.yml';
export const CODEOWNERS_PATHS: readonly string[] = [
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
];
export const MERGE_QUEUE_RULESET = 'talos-merge-queue';
export const OWNER_REVIEW_RULESET = 'talos-owner-review';
export const DRIFT_LABEL = 'drift';
const DRIFT_MARKER = 'talos-drift/1';

/** Rebase merges only, through auto-merge and the queue; PRs only from collaborators. */
export const GOVERNED_SETTINGS: Readonly<Record<string, boolean | string>> = {
  allow_rebase_merge: true,
  allow_squash_merge: false,
  allow_merge_commit: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
  pull_request_creation_policy: 'collaborators_only',
};

export type Expected = {
  readonly settings: Readonly<Record<string, boolean | string>>;
  readonly caller: string;
  readonly codeowners: string;
  /** The merge-queue ruleset as Talos creates it. */
  readonly mergeQueue: unknown;
};

export type DriftState = {
  /** The repository as `GET /repos/{repo}` returns it to `administration: read`. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Dependabot alerts; `undefined` when the token couldn't tell. */
  readonly alerts: boolean | undefined;
  readonly channel: string | undefined;
  readonly caller: string | undefined;
  readonly codeowners: string | undefined;
  /** The repository's own rulesets, by name, as GitHub returns them. */
  readonly rulesets: Readonly<Record<string, unknown>>;
};

export type Difference = {
  /** Stable across runs: one issue per key. */
  readonly key: string;
  readonly what: string;
  readonly expected: string;
  readonly actual: string;
};

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

/** A JSON object: not null, not an array. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !isList(value);

/**
 * Whether `actual` holds everything `wanted` says: GitHub's answers carry more than Talos sends
 * (ids, links, defaults). Arrays match in any order and must be as long.
 */
export function holds(actual: unknown, wanted: unknown): boolean {
  if (isList(wanted)) {
    if (!isList(actual) || actual.length !== wanted.length) return false;
    const left = [...actual];
    return wanted.every((item) => {
      const at = left.findIndex((candidate) => holds(candidate, item));
      if (at === -1) return false;
      left.splice(at, 1);
      return true;
    });
  }
  if (isObject(wanted)) {
    return isObject(actual) && Object.entries(wanted).every(([k, v]) => holds(actual[k], v));
  }
  return Object.is(actual, wanted);
}

function settingDifferences(state: DriftState, expected: Expected): Difference[] {
  return Object.entries(expected.settings).flatMap(([name, value]) => {
    const actual = state.settings[name];
    if (actual === undefined || Object.is(actual, value)) return [];
    const shown =
      typeof actual === 'string' || typeof actual === 'boolean' ? String(actual) : 'set';
    return [
      { key: `setting:${name}`, what: `\`${name}\``, expected: String(value), actual: shown },
    ];
  });
}

function fileDifference(key: string, what: string, text: string | undefined, want: string) {
  if (text?.replaceAll('\r\n', '\n') === want) return [];
  return [
    { key, what, expected: "Talos's copy", actual: text === undefined ? 'missing' : 'changed' },
  ];
}

function rulesetDifferences(state: DriftState, expected: Expected): Difference[] {
  const diffs: Difference[] = [];
  const queue = state.rulesets[MERGE_QUEUE_RULESET];
  if (queue === undefined || !holds(queue, expected.mergeQueue)) {
    diffs.push({
      key: `ruleset:${MERGE_QUEUE_RULESET}`,
      what: `the \`${MERGE_QUEUE_RULESET}\` ruleset`,
      expected: 'present, as Talos creates it',
      actual: queue === undefined ? 'missing' : 'changed',
    });
  }
  const wantsOwnerReview = state.channel === 'evaluate';
  const hasOwnerReview = state.rulesets[OWNER_REVIEW_RULESET] !== undefined;
  if (wantsOwnerReview !== hasOwnerReview) {
    diffs.push({
      key: `ruleset:${OWNER_REVIEW_RULESET}`,
      what: `the \`${OWNER_REVIEW_RULESET}\` ruleset`,
      expected: wantsOwnerReview ? 'present while at evaluate' : 'gone once on a channel',
      actual: hasOwnerReview ? 'present' : 'missing',
    });
  }
  return diffs;
}

/** Every way the repository differs from what `talos govern` sets. */
export function differences(state: DriftState, expected: Expected): Difference[] {
  const channels = new Set(['evaluate', 'canary', 'stable']);
  return [
    ...settingDifferences(state, expected),
    ...(state.alerts === false
      ? [{ key: 'alerts', what: 'Dependabot alerts', expected: 'on', actual: 'off' }]
      : []),
    ...(channels.has(state.channel ?? '')
      ? []
      : [
          {
            key: 'property:talos',
            what: 'the `talos` property',
            expected: 'evaluate, canary or stable',
            actual: state.channel ?? 'unset',
          },
        ]),
    ...fileDifference('file:caller', `\`${CALLER_PATH}\``, state.caller, expected.caller),
    ...fileDifference('file:codeowners', '`CODEOWNERS`', state.codeowners, expected.codeowners),
    ...rulesetDifferences(state, expected),
  ];
}

/** A hidden first line that lets a later run find the issue again. */
export function driftMarker(key: string): string {
  return `<!-- ${DRIFT_MARKER} key=${encodeURIComponent(key)} -->`;
}

/** The key of a body's drift marker, hidden or visible, or `undefined` without one. */
export function driftKey(body: string): string | undefined {
  let line = (body.trimStart().split(/\r?\n/, 1)[0] ?? '').trim();
  if (line.startsWith('<!--') && line.endsWith('-->')) line = line.slice(4, -3).trim();
  const match = new RegExp(`^${DRIFT_MARKER.replace('/', '\\/')} key=(\\S+)$`).exec(line);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/** The issue for one difference; the owner fixes it by running `talos govern` again. */
export function driftIssue(diff: Difference): IssueDraft {
  const body = [
    driftMarker(diff.key),
    '',
    '### Goal',
    '',
    `Bring ${diff.what} back to what \`talos govern\` sets.`,
    '',
    '### Acceptance criteria',
    '',
    '- [ ] The weekly drift report finds no difference here (it closes this issue itself)',
    '',
    '### Out of scope',
    '',
    'Every other setting: each difference has an issue of its own.',
    '',
    '### Affected areas',
    '',
    `- ${diff.what}`,
    '',
    '### Difference',
    '',
    `Expected: ${diff.expected}. Actual: ${diff.actual}.`,
    '',
    "Settings need the owner's administration rights: `talos govern` applies them again, and " +
      'prints the steps the API does not expose.',
    '',
  ].join('\n');
  return {
    title: `Drift: ${diff.what.replaceAll('`', '')} differs from what talos govern sets`,
    body,
    labels: [DRIFT_LABEL, LABEL.chore, LABEL.p2],
  };
}

export type OpenDriftIssue = { readonly number: number; readonly body: string };

/**
 * What to file and what to close: one open issue per difference, and an open issue whose
 * difference is gone closed. `owns` limits the run to the keys it checks, so the channels-file
 * check and the repository's own report leave each other's issues alone.
 */
export function reconcile(
  diffs: readonly Difference[],
  open: readonly OpenDriftIssue[],
  owns: (key: string) => boolean,
): { file: Difference[]; close: number[] } {
  const keyed = open.flatMap((issue) => {
    const key = driftKey(issue.body);
    return key !== undefined && owns(key) ? [{ number: issue.number, key }] : [];
  });
  const filed = new Set(keyed.map((issue) => issue.key));
  const current = new Set(diffs.map((diff) => diff.key));
  return {
    file: diffs.filter((diff) => owns(diff.key) && !filed.has(diff.key)),
    close: keyed.filter((issue) => !current.has(issue.key)).map((issue) => issue.number),
  };
}

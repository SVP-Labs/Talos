import { installationSteps } from './installations.js';
import {
  CALLER_PATH,
  CODEOWNERS_PATHS,
  MERGE_QUEUE_RULESET,
  OWNER_REVIEW_RULESET,
  type RepoSettings,
  type RepoState,
} from './state.js';
import { change, manual, ok, rulesetStep, type Step } from './steps.js';
import { type Channel, isChannel, type RulesetBody, type Templates } from './templates.js';
import { oldKitCallers } from '../adopt/scaffold.js';

/** What the owner asked `talos govern` for. */
export type GovernRequest = {
  /** The owner's login, the one code owner. */
  readonly owner: string;
  /** `talos-agents`; `undefined` keeps what the repository has (off when unset). */
  readonly agents: boolean | undefined;
  /** `--channel`: moves the repository off `evaluate`. */
  readonly channel: Exclude<Channel, 'evaluate'> | undefined;
  /** The caller workflow Talos ships (`assets/workflows/talos.yml`). */
  readonly caller: string;
  /** `assets/codeowners`, with `@OWNER` standing for the owner's login. */
  readonly codeowners: string;
  readonly templates: Templates;
  /** Files written once with the caller when missing, such as `talos new`'s `talos.yml`. */
  readonly seed?: Readonly<Record<string, string>>;
};

export class GovernRefusal extends Error {
  override readonly name = 'GovernRefusal';
}

type SettingKey = keyof RepoSettings;

/** The settings every governed repository has: rebase merges only, through auto-merge. */
const SETTINGS: Readonly<Record<SettingKey, boolean | string>> = {
  allow_rebase_merge: true,
  allow_squash_merge: false,
  allow_merge_commit: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
  pull_request_creation_policy: 'collaborators_only',
};

const SETTING_KEYS: readonly SettingKey[] = [
  'allow_rebase_merge',
  'allow_squash_merge',
  'allow_merge_commit',
  'allow_auto_merge',
  'delete_branch_on_merge',
  'pull_request_creation_policy',
];

export function codeownersText(template: string, owner: string): string {
  return template.replaceAll('@OWNER', `@${owner}`);
}

/** The channel the repository ends at: the one asked for, the one it has, or `evaluate`. */
export function targetChannel(state: RepoState, request: GovernRequest): Channel {
  const current = state.properties.talos ?? undefined;
  if (request.channel !== undefined) {
    if (!isChannel(current)) {
      throw new GovernRefusal(
        'a repository comes in at evaluate: run `talos govern` without --channel first',
      );
    }
    return request.channel;
  }
  return isChannel(current) ? current : 'evaluate';
}

function hasOwnRulesets(state: RepoState): boolean {
  return state.rulesets.some(
    (r) => r.name === MERGE_QUEUE_RULESET || r.name === OWNER_REVIEW_RULESET,
  );
}

type Additions = { path: string; contents: string }[];

function fileChanges(
  state: RepoState,
  request: GovernRequest,
): { additions: Additions; deletions: string[] } {
  const additions: Additions = [];
  if (state.caller !== request.caller) {
    additions.push({ path: CALLER_PATH, contents: request.caller });
  }
  const owners = codeownersText(request.codeowners, request.owner);
  if (state.codeowners?.text !== owners) {
    additions.push({ path: state.codeowners?.path ?? CODEOWNERS_PATHS[0] ?? '', contents: owners });
  }
  for (const [path, contents] of Object.entries(request.seed ?? {})) {
    if (state.extra[path] === undefined) additions.push({ path, contents });
  }
  const deletions = oldKitCallers(state.workflows).filter((path) => path !== CALLER_PATH);
  return { additions, deletions };
}

/**
 * The caller and CODEOWNERS go straight onto the default branch, before any ruleset exists: no
 * App may write a workflow file, and a PR's own caller never runs on that PR. Once the rulesets
 * exist, the branch takes no direct commit, so a difference then is a PR for the owner to open.
 */
function filesStep(state: RepoState, request: GovernRequest, channel: Channel): Step {
  const { additions, deletions } = fileChanges(state, request);
  const branch = state.defaultBranch;
  if (additions.length === 0 && deletions.length === 0) {
    return ok('files', `the caller and CODEOWNERS are on ${branch}`);
  }
  const paths = [...additions.map((a) => a.path), ...deletions];
  if (hasOwnRulesets(state) || channel !== 'evaluate') {
    return manual(
      'files',
      `${paths.join(', ')} differ from Talos's; ${branch} takes no direct commit once it is ` +
        'governed, so change them through a PR',
    );
  }
  const removed = deletions.length > 0 ? `, delete ${deletions.length} old-kit caller(s)` : '';
  return change('files', `commit ${additions.map((a) => a.path).join(', ')}${removed}`, {
    kind: 'commit',
    repo: state.repo,
    changes: {
      branch,
      expectedHead: state.head,
      message: 'Govern the repository with Talos\n\nThe caller workflow and CODEOWNERS.',
      additions,
      deletions,
    },
  });
}

function settingsSteps(state: RepoState): Step[] {
  const steps: Step[] = [];
  const body: Record<string, boolean | string> = {};
  for (const key of SETTING_KEYS) {
    const current = state.settings[key];
    if (key === 'pull_request_creation_policy' && current === undefined) {
      steps.push(
        manual(
          'pull-requests',
          'restrict pull request creation to collaborators: Settings → General → Pull Requests',
        ),
      );
      continue;
    }
    if (current !== SETTINGS[key]) body[key] = SETTINGS[key];
  }
  const keys = Object.keys(body);
  steps.unshift(
    keys.length === 0
      ? ok('settings', 'rebase-only merges, auto-merge, PRs from collaborators only')
      : change('settings', `set ${keys.join(', ')}`, {
          kind: 'patch-repo',
          repo: state.repo,
          body,
        }),
  );
  steps.push(
    manual(
      'issues',
      'restrict issue creation to collaborators: Settings → General → Features → Issues ' +
        "(GitHub's API has no field for it)",
    ),
  );
  return steps;
}

function repoRuleset(state: RepoState, desired: RulesetBody): Step {
  const current = state.rulesets.find((ruleset) => ruleset.name === desired.name);
  return rulesetStep({ kind: 'repo', repo: state.repo }, current, desired);
}

function propertiesStep(state: RepoState, request: GovernRequest, channel: Channel): Step {
  const agents =
    request.agents === undefined
      ? (state.properties['talos-agents'] ?? 'false')
      : String(request.agents);
  const wanted = { talos: channel, 'talos-agents': agents };
  const values = Object.entries(wanted)
    .filter(([name, value]) => state.properties[name] !== value)
    .map(([name, value]) => ({ property_name: name, value }));
  const detail = `talos=${channel}, talos-agents=${agents}`;
  if (values.length === 0) return ok('properties', detail);
  return change('properties', `set ${detail}`, {
    kind: 'set-properties',
    repo: state.repo,
    values,
  });
}

/**
 * Everything `talos govern` would do to a repository, in the order it must happen: the files
 * before any ruleset, the property before the owner's review rule goes, so a repository moving
 * to a channel is never without an approval gate.
 */
export function governPlan(state: RepoState, request: GovernRequest): Step[] {
  const channel = targetChannel(state, request);
  const ownerReview = state.rulesets.find((r) => r.name === OWNER_REVIEW_RULESET);
  const atEvaluate = channel === 'evaluate';
  return [
    filesStep(state, request, channel),
    ...settingsSteps(state),
    repoRuleset(state, request.templates.mergeQueue),
    ...(atEvaluate ? [repoRuleset(state, request.templates.ownerReview)] : []),
    state.alerts
      ? ok('alerts', 'Dependabot alerts are on')
      : change('alerts', 'switch on Dependabot alerts', {
          kind: 'enable-alerts',
          repo: state.repo,
        }),
    propertiesStep(state, request, channel),
    ...(!atEvaluate && ownerReview !== undefined
      ? [
          change(`ruleset:${OWNER_REVIEW_RULESET}`, `delete ${OWNER_REVIEW_RULESET}`, {
            kind: 'delete-ruleset',
            scope: { kind: 'repo', repo: state.repo },
            id: ownerReview.id,
          }),
        ]
      : []),
    ...installationSteps(state.installations, { id: state.id, name: state.repo }),
  ];
}

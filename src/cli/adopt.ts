import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RUN_FLAGS, targetRepository } from './govern.js';
import { type Command, type Io, parse, UsageError } from './io.js';
import { loadAdoptAssets } from '../adopt/assets.js';
import { AdoptRefusal } from '../adopt/config.js';
import type { OsOverride } from '../adopt/detect.js';
import {
  applyPlan,
  checkoutClaim,
  commitPaths,
  isClean,
  pushBranch,
  readTree,
} from '../adopt/local.js';
import {
  type AdoptAssets,
  type AdoptInput,
  type AdoptPlan,
  adoptPlan,
  executablePaths,
  touchedPaths,
} from '../adopt/plan.js';
import { openBootstrapPull, startAdoption } from '../adopt/remote.js';
import { bootstrapSubject } from '../adopt/texts.js';
import type { Lang, Os } from '../core/check.js';
import type { Pack } from '../core/pack.js';
import { PACKS } from '../core/registry.js';
import { exec as realExec, type Exec } from '../exec/exec.js';
import {
  github,
  type GitHub,
  GitHubError,
  type GitHubOptions,
  tokenFromEnvironment,
} from '../github/api.js';
import { identities } from '../github/identities.js';
import { type PrefixUse, prefixesInUse } from '../govern/create.js';
import { capped, clip } from '../govern/output.js';
import { branchFor } from '../ticket/claim.js';
import { ownVersion } from '../version/self.js';

const USAGE =
  'usage: talos adopt [plan|start|files|pr] [--repo owner/name] [--name <Name>] [--prefix <P>] ' +
  '[--os [<lang>[@<root>]=]<os>,...] [--brief <file>] [--issue <N>] [--agent <id>] [--json]';

const SCHEMA = 'talos.adopt/1';
const LANGS: readonly string[] = ['ts', 'py', 'php', 'lua', 'rust'];
const OSES: readonly string[] = ['linux', 'windows', 'macos'];

function isLang(value: string): value is Lang {
  return LANGS.includes(value);
}

function isOs(value: string): value is Os {
  return OSES.includes(value);
}

/** `--os linux,windows`, `--os rust=linux,windows` or `--os rust@apps/desktop=linux,windows`. */
export function parseOs(specs: readonly string[]): OsOverride[] {
  return specs.map((spec) => {
    const match = /^(?:([a-z]+)(?:@([^=]+))?=)?([a-z,]+)$/.exec(spec);
    const os = (match?.[3] ?? '').split(',');
    const lang = match?.[1];
    if (match === null || !os.every(isOs) || (lang !== undefined && !isLang(lang))) {
      throw new UsageError(
        `--os ${spec}: [<lang>[@<root>]=]<os>,... with os linux, windows, macos`,
      );
    }
    return {
      ...(lang === undefined ? {} : { lang }),
      ...(match[2] === undefined ? {} : { root: match[2] }),
      os,
    };
  });
}

function issueOf(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value)) {
    throw new UsageError('--issue <N> is required: the bootstrap issue `talos adopt start` filed');
  }
  return Number(value);
}

export type AdoptDeps = GitHubOptions & {
  readonly assets?: () => Promise<AdoptAssets>;
  readonly packs?: readonly Pack[];
  readonly now?: () => Date;
  readonly exec?: Exec;
};

type Args = {
  readonly repo: string | undefined;
  readonly name: string | undefined;
  readonly prefix: string | undefined;
  readonly os: OsOverride[];
  readonly brief: string | undefined;
};

type Session = {
  readonly io: Io;
  readonly deps: AdoptDeps;
  readonly run: Exec;
  readonly now: Date;
  readonly repo: string;
};

/** What the organisation knows of prefixes: `undefined` when the plan can't consult it. */
type Prefixes = readonly PrefixUse[] | undefined;

async function planHere(session: Session, args: Args, prefixes?: Prefixes): Promise<AdoptPlan> {
  const tree = await readTree(session.io.cwd, session.run);
  const brief =
    args.brief === undefined
      ? undefined
      : { fileName: args.brief, text: await readFile(resolve(session.io.cwd, args.brief), 'utf8') };
  const input: AdoptInput = {
    repo: session.repo,
    files: tree.files,
    read: tree.read,
    name: args.name,
    prefix: args.prefix,
    os: args.os,
    brief,
    now: session.now,
    version: ownVersion(),
    packs: session.deps.packs ?? PACKS,
    assets: await (session.deps.assets ?? loadAdoptAssets)(),
    prefixesInUse: prefixes,
  };
  return adoptPlan(input);
}

function planJson(plan: AdoptPlan): Record<string, unknown> {
  return {
    name: plan.config.name,
    prefix: plan.config.prefix,
    talosYml: plan.talosYml,
    components: capped(plan.config.components),
    scaffold: plan.scaffold,
    brief: plan.brief ?? null,
    write: capped(plan.write.map((f) => ({ path: f.path, why: f.why }))),
    delete: capped(plan.delete),
    next: capped(plan.next.map((step) => clip(step))),
  };
}

async function client(session: Session): Promise<GitHub> {
  return github(await tokenFromEnvironment(session.io.env), session.deps);
}

/**
 * The prefixes the organisation's other repositories use, as `talos new` reads them; `undefined`
 * when the token can't read the organisation, and then the prefix goes unchecked.
 */
async function orgPrefixes(session: Session): Promise<Prefixes> {
  const org = session.repo.split('/')[0] ?? session.repo;
  try {
    return await prefixesInUse(await client(session), org);
  } catch (error) {
    if (error instanceof GitHubError && [401, 403, 404].includes(error.status)) return undefined;
    throw error;
  }
}

function bootstrapText(plan: AdoptPlan): {
  name: string;
  brief: string | undefined;
  scaffold: boolean;
} {
  return { name: plan.config.name, brief: plan.brief, scaffold: plan.scaffold };
}

async function start(session: Session, plan: AdoptPlan, agent: string) {
  return startAdoption(await client(session), session.repo, identities(session.io.env), {
    ...bootstrapText(plan),
    prefix: plan.config.prefix,
    agent,
    now: session.now,
  });
}

async function openPull(session: Session, plan: AdoptPlan, issue: number) {
  return openBootstrapPull(await client(session), session.repo, {
    ...bootstrapText(plan),
    prefix: plan.config.prefix,
    issue,
  });
}

function commitSteps(plan: AdoptPlan, issue: number): string[] {
  const branch = branchFor(plan.config.prefix, issue);
  const executable = executablePaths(plan);
  const chmod =
    executable.length === 0 ? '' : ` && git update-index --chmod=+x -- ${executable.join(' ')}`;
  const subject = bootstrapSubject(plan.config.prefix, issue, plan.config.name);
  return [
    `git add -A${chmod} && git commit -m "${subject}"`,
    `git push origin ${branch}`,
    `talos adopt pr --issue ${issue}`,
  ];
}

/**
 * Every step at once, for a person in a clean clone. It stops before committing when a lock file
 * must be refreshed first, and says how.
 */
async function everything(session: Session, args: Args, agent: string) {
  if (!(await isClean(session.io.cwd, session.run))) {
    throw new AdoptRefusal('the working tree has changes: commit or stash them first');
  }
  const prefixes = await orgPrefixes(session);
  const started = await start(session, await planHere(session, args, prefixes), agent);
  await checkoutClaim(session.io.cwd, session.run, started.branch);
  const plan = await planHere(session, args, prefixes);
  await applyPlan(session.io.cwd, plan);
  const base = {
    step: 'adopt',
    ...started,
    ...planJson(plan),
    prefixChecked: prefixes !== undefined,
  };
  if (plan.next.length > 0) {
    const next = [...plan.next, ...commitSteps(plan, started.issue)];
    return { ...base, done: false, next: capped(next.map((s) => clip(s))) };
  }
  const subject = bootstrapSubject(plan.config.prefix, started.issue, plan.config.name);
  const staging = { paths: touchedPaths(plan), executable: executablePaths(plan) };
  await commitPaths(session.io.cwd, session.run, staging, subject);
  await pushBranch(session.io.cwd, session.run, started.branch);
  const pull = await openPull(session, plan, started.issue);
  return { ...base, done: true, ...pull };
}

type Values = {
  readonly issue: string | undefined;
  readonly agent: string | undefined;
};

async function dispatch(sub: string | undefined, session: Session, args: Args, values: Values) {
  const agent = values.agent ?? identities(session.io.env).owner;
  switch (sub) {
    case 'plan': {
      return { step: 'plan', ...planJson(await planHere(session, args)) };
    }
    case 'start': {
      const prefixes = await orgPrefixes(session);
      const plan = await planHere(session, args, prefixes);
      return {
        step: 'start',
        ...(await start(session, plan, agent)),
        prefixChecked: prefixes !== undefined,
      };
    }
    case 'files': {
      const issue = issueOf(values.issue);
      const plan = await planHere(session, args);
      await applyPlan(session.io.cwd, plan);
      const next = [...plan.next, ...commitSteps(plan, issue)].map((s) => clip(s));
      return {
        step: 'files',
        issue,
        branch: branchFor(plan.config.prefix, issue),
        ...planJson(plan),
        next: capped(next),
      };
    }
    case 'pr': {
      const issue = issueOf(values.issue);
      return {
        step: 'pr',
        issue,
        ...(await openPull(session, await planHere(session, args), issue)),
      };
    }
    case undefined: {
      return everything(session, args, agent);
    }
    default: {
      throw new UsageError(USAGE);
    }
  }
}

function text(output: Record<string, unknown>): string {
  return `${Object.entries(output)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n')}\n`;
}

/** `talos adopt` with a GitHub client, assets and packs of the caller's choosing (tests). */
export function adoptWith(deps: AdoptDeps): Command {
  return async (argv, io) => {
    const { values, positionals } = parse(
      argv,
      {
        repo: { type: 'string' },
        name: { type: 'string' },
        prefix: { type: 'string' },
        os: { type: 'string', multiple: true, default: [] },
        brief: { type: 'string' },
        issue: { type: 'string' },
        agent: { type: 'string' },
        ...RUN_FLAGS,
      },
      true,
    );
    if (positionals.length > 1) throw new UsageError(USAGE);
    const sub = values['dry-run'] ? 'plan' : positionals[0];
    const args: Args = {
      repo: values.repo,
      name: values.name,
      prefix: values.prefix,
      os: parseOs(values.os),
      brief: values.brief,
    };
    const repo = await targetRepository(values.repo, io);
    const session: Session = {
      io,
      deps,
      run: deps.exec ?? realExec,
      now: (deps.now ?? (() => new Date()))(),
      repo,
    };
    try {
      const output = {
        schema: SCHEMA,
        repo,
        ...(await dispatch(sub, session, args, { issue: values.issue, agent: values.agent })),
      };
      io.out(values.json ? `${JSON.stringify(output)}\n` : text(output));
      return 0;
    } catch (error) {
      if (!(error instanceof AdoptRefusal)) throw error;
      io.err(`talos adopt: ${error.message}\n`);
      return 1;
    }
  };
}

/**
 * `talos adopt`: brings a repository's files under Talos, and touches no setting, so Thea's App
 * can run it. `plan` (or `--dry-run`) prints what it would do; `start` refuses a prefix another
 * repository of the organisation uses, labels the repository, marks the old backlog `legacy`
 * and files and claims the bootstrap issue; `files` writes the working tree (no token needed);
 * `pr` opens the bootstrap PR. Without a step it does them all, stopping before the commit when
 * lock files must be refreshed first.
 */
export const adopt: Command = adoptWith({});

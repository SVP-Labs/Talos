import { governOutput, onOff, printReport, RUN_FLAGS } from './govern.js';
import { type Command, parse, required, UsageError } from './io.js';
import { github, type GitHubOptions, tokenFromEnvironment } from '../github/api.js';
import { ownerIdentities } from '../github/org-variables.js';
import {
  checkNew,
  createRepository,
  nameProblem,
  prefixProblem,
  seedConfig,
  type Sleep,
  whenReady,
} from '../govern/create.js';
import {
  assertOwner,
  type GovernAssets,
  governRepository,
  loadGovernAssets,
} from '../govern/govern.js';
import { GovernRefusal } from '../govern/plan.js';

const USAGE =
  'usage: talos new <Name> --prefix <P> [--public] [--agents on|off] [--dry-run] [--json]';

function checked(value: string, problem: (value: string) => string | undefined): string {
  const found = problem(value);
  if (found !== undefined) throw new UsageError(found);
  return value;
}

export type NewDeps = GitHubOptions & {
  readonly assets?: () => Promise<GovernAssets>;
  readonly sleep?: Sleep;
};

const pause: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** `talos new` with a GitHub client, assets and clock of the caller's choosing (tests). */
export function newWith(deps: NewDeps): Command {
  return async (argv, io) => {
    const { values, positionals } = parse(
      argv,
      {
        prefix: { type: 'string' },
        public: { type: 'boolean', default: false },
        agents: { type: 'string' },
        ...RUN_FLAGS,
      },
      true,
    );
    const [named] = positionals;
    if (named === undefined || positionals.length > 1) throw new UsageError(USAGE);
    const name = checked(named, nameProblem);
    const prefix = checked(required(values.prefix, 'prefix'), prefixProblem);
    const agents = onOff(values.agents, 'agents');
    const gh = github(await tokenFromEnvironment(io.env), deps);
    const who = await ownerIdentities(gh, io.env, (line) =>
      io.err(`talos new: ${line}
`),
    );
    const repo = `${who.org}/${name}`;
    try {
      await assertOwner(gh, who);
      await checkNew(gh, who.org, name, prefix);
      const assets = await (deps.assets ?? loadGovernAssets)();
      if (values['dry-run']) {
        const json = { schema: 'talos.new/1', repo, prefix, dryRun: true, create: true };
        return printReport(
          io,
          { json, text: `talos new: would create ${repo}\n`, ok: true },
          values.json,
        );
      }
      await createRepository(gh, who.org, name, values.public ? 'public' : 'private');
      const report = await whenReady(
        () =>
          governRepository({
            gh,
            who,
            repo,
            agents,
            channel: undefined,
            dryRun: false,
            assets,
            seed: { 'talos.yml': seedConfig(name, prefix) },
          }),
        deps.sleep ?? pause,
      );
      return printReport(io, governOutput(report), values.json);
    } catch (error) {
      if (!(error instanceof GovernRefusal)) throw error;
      io.err(`talos new: ${error.message}\n`);
      return 1;
    }
  };
}

/**
 * `talos new <Name> --prefix <P>`: the owner, with their own login, creates a private repository
 * in the organisation (public with `--public`) and governs it. A prefix another repository uses
 * is refused; the new repository's `talos.yml` records its name and prefix until `talos adopt`
 * fills in the rest.
 */
export const newRepo: Command = newWith({});

import { type Command, type Io, parse, UsageError } from './io.js';
import { exec } from '../exec/exec.js';
import { github, type GitHubOptions, tokenFromEnvironment } from '../github/api.js';
import { ownerIdentities } from '../github/org-variables.js';
import { currentRepository, isRepoName } from '../github/remote.js';
import {
  type GovernAssets,
  governJson,
  governRepository,
  type GovernReport,
  loadGovernAssets,
} from '../govern/govern.js';
import { stepsText } from '../govern/output.js';
import { GovernRefusal } from '../govern/plan.js';

const USAGE =
  'usage: talos govern [owner/name] [--agents on|off] [--channel canary|stable] ' +
  '[--dry-run] [--json]';

/** The flags every command of the owner's and of adoption takes. */
export const RUN_FLAGS = {
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
} as const;

/** `on`/`off` for a flag that may be left out. */
export function onOff(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'on' || value === 'true') return true;
  if (value === 'off' || value === 'false') return false;
  throw new UsageError(`--${flag} takes on or off, not ${value}`);
}

function channelOf(value: string | undefined): 'canary' | 'stable' | undefined {
  if (value === undefined || value === 'canary' || value === 'stable') return value;
  throw new UsageError(`--channel takes canary or stable, not ${value}`);
}

/** The repository named on the command line, or the one the clone at `cwd` belongs to. */
export async function targetRepository(named: string | undefined, io: Io): Promise<string> {
  if (named !== undefined) {
    if (!isRepoName(named)) throw new UsageError(`a repository is owner/name, not ${named}`);
    return named;
  }
  const found = await currentRepository(io.env, io.cwd, exec);
  if (found === undefined) throw new UsageError(`no repository here: ${USAGE}`);
  return found;
}

/** Prints a report and turns it into the exit code: 1 when a step failed. */
export function printReport(
  io: Io,
  report: { json: Record<string, unknown>; text: string; ok: boolean },
  asJson: boolean,
): number {
  io.out(asJson ? `${JSON.stringify(report.json)}\n` : report.text);
  return report.ok ? 0 : 1;
}

export function governOutput(report: GovernReport): {
  json: Record<string, unknown>;
  text: string;
  ok: boolean;
} {
  const json = governJson(report);
  const verb = report.dryRun ? 'would govern' : 'governed';
  return {
    json,
    text: stepsText(`talos govern: ${verb} ${report.repo} at ${report.channel}`, report.results),
    ok: json.ok === true,
  };
}

export type GovernDeps = GitHubOptions & { readonly assets?: () => Promise<GovernAssets> };

/** `talos govern` with a GitHub client and assets of the caller's choosing (tests). */
export function governWith(deps: GovernDeps): Command {
  return async (argv, io) => {
    const { values, positionals } = parse(
      argv,
      {
        agents: { type: 'string' },
        channel: { type: 'string' },
        ...RUN_FLAGS,
      },
      true,
    );
    if (positionals.length > 1) throw new UsageError(USAGE);
    const agents = onOff(values.agents, 'agents');
    const channel = channelOf(values.channel);
    const repo = await targetRepository(positionals[0], io);
    const gh = github(await tokenFromEnvironment(io.env), deps);
    try {
      const report = await governRepository({
        gh,
        who: await ownerIdentities(gh, io.env, (line) =>
          io.err(`talos govern: ${line}
`),
        ),
        repo,
        agents,
        channel,
        dryRun: values['dry-run'],
        assets: await (deps.assets ?? loadGovernAssets)(),
      });
      return printReport(io, governOutput(report), values.json);
    } catch (error) {
      if (!(error instanceof GovernRefusal)) throw error;
      io.err(`talos govern: ${error.message}\n`);
      return 1;
    }
  };
}

/**
 * `talos govern`: the owner brings a repository under Talos's settings: the caller and
 * CODEOWNERS on the default branch, the merge-queue and owner-review rulesets, merge settings,
 * Dependabot alerts, the `talos` properties and the three Apps. Reruns change only what differs.
 */
export const govern: Command = governWith({});

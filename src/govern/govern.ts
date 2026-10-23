import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { stepsOutput } from './output.js';
import { GovernRefusal, governPlan, type GovernRequest, targetChannel } from './plan.js';
import { readRepoState } from './state.js';
import { applySteps, planned, scopeHint, type StepResult } from './steps.js';
import { loadTemplates } from './templates.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import { assetsDir } from '../version/self.js';

const GOVERN_SCHEMA = 'talos.govern/1';

export type GovernAssets = Pick<GovernRequest, 'caller' | 'codeowners' | 'templates'>;

/** The caller, the CODEOWNERS template and the ruleset templates Talos ships. */
export async function loadGovernAssets(dir: URL = assetsDir()): Promise<GovernAssets> {
  const read = async (path: string): Promise<string> => {
    try {
      return await readFile(new URL(path, dir), 'utf8');
    } catch {
      throw new Error(`this Talos ships no assets/${path}`);
    }
  };
  const [caller, codeowners, templates] = await Promise.all([
    read('workflows/talos.yml'),
    read('codeowners'),
    loadTemplates(dir),
  ]);
  return { caller, codeowners, templates };
}

const userSchema = z.object({ login: z.string() });

/**
 * `talos govern` runs as the owner, with their own login: every step needs administration rights
 * no App holds, and the commit it makes must be the owner's.
 */
export async function assertOwner(gh: GitHub, who: Identities): Promise<void> {
  const user = await gh.request<unknown>('GET', 'user').catch(() => undefined);
  const login = userSchema.safeParse(user).data?.login;
  if (login?.toLowerCase() !== who.owner.toLowerCase()) {
    throw new GovernRefusal(
      `talos govern runs as the owner (${who.owner}) with their own login (gh auth login); ` +
        `this token is ${login ?? 'not a user'}`,
    );
  }
}

export type GovernOptions = {
  readonly gh: GitHub;
  readonly who: Identities;
  readonly repo: string;
  readonly agents: boolean | undefined;
  readonly channel: GovernRequest['channel'];
  readonly dryRun: boolean;
  readonly assets: GovernAssets;
  readonly seed?: Readonly<Record<string, string>>;
};

export type GovernReport = {
  readonly schema: typeof GOVERN_SCHEMA;
  readonly repo: string;
  readonly channel: string;
  readonly dryRun: boolean;
  readonly results: readonly StepResult[];
};

/** Reads the repository, plans, and applies the plan unless it is a dry run. */
export async function governRepository(options: GovernOptions): Promise<GovernReport> {
  await assertOwner(options.gh, options.who);
  const seedPaths = Object.keys(options.seed ?? {});
  const state = await readRepoState(options.gh, options.repo, options.who, {
    extraPaths: seedPaths,
  });
  const request: GovernRequest = {
    owner: options.who.owner,
    agents: options.agents,
    channel: options.channel,
    ...options.assets,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };
  const steps = governPlan(state, request);
  const results = options.dryRun ? planned(steps) : await applySteps(options.gh, steps, scopeHint);
  return {
    schema: GOVERN_SCHEMA,
    repo: options.repo,
    channel: targetChannel(state, request),
    dryRun: options.dryRun,
    results,
  };
}

/** The report as agents read it (`talos.govern/1`): capped, clipped, manual steps apart. */
export function governJson(report: GovernReport): Record<string, unknown> {
  return {
    schema: report.schema,
    repo: report.repo,
    channel: report.channel,
    dryRun: report.dryRun,
    ...stepsOutput(report.results),
  };
}

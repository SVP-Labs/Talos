import { printReport, RUN_FLAGS } from './govern.js';
import { type Command, parse, UsageError } from './io.js';
import { github, type GitHub, type GitHubOptions, tokenFromEnvironment } from '../github/api.js';
import { identities, type Identities } from '../github/identities.js';
import { assertOwner } from '../govern/govern.js';
import {
  channelRulesets,
  orgPlan,
  type PinReport,
  pinsOf,
  readOrgState,
  releasesOf,
} from '../govern/org.js';
import { stepsOutput, stepsText } from '../govern/output.js';
import { GovernRefusal } from '../govern/plan.js';
import { applySteps, planned, scopeHint } from '../govern/steps.js';
import { loadTemplates, type Templates } from '../govern/templates.js';

const USAGE = 'usage: talos org init [--seed <sha>] [--dry-run] [--json] | pins [--json]';
const SCHEMA = 'talos.org/1';

type InitArgs = { readonly seed: string | undefined; readonly dryRun: boolean };

async function init(gh: GitHub, who: Identities, templates: Templates, args: InitArgs) {
  await assertOwner(gh, who);
  const state = await readOrgState(gh, who, templates);
  const steps = orgPlan(state, templates, args.seed);
  const results = args.dryRun ? planned(steps) : await applySteps(gh, steps, scopeHint);
  const output = stepsOutput(results);
  const verb = args.dryRun ? 'would set up' : 'set up';
  return {
    json: { schema: SCHEMA, org: who.org, dryRun: args.dryRun, ...output },
    text: stepsText(`talos org init: ${verb} ${who.org}`, results),
    ok: output.ok,
  };
}

function pinsText(org: string, pins: readonly PinReport[]): string {
  const lines = pins.map(
    (p) => `${p.channel.padEnd(8)}  ${p.tag ?? '-'}  ${p.sha ?? 'no pin'}  ${p.enforcement ?? ''}`,
  );
  return `talos org pins: ${org}\n${lines.join('\n')}\n`;
}

async function pins(gh: GitHub, who: Identities) {
  const [channels, releases] = await Promise.all([
    channelRulesets(gh, who.org),
    releasesOf(gh, who.talosRepo),
  ]);
  const found = pinsOf(channels, releases);
  return {
    json: { schema: SCHEMA, org: who.org, pins: found },
    text: pinsText(who.org, found),
    ok: found.every((pin) => pin.sha !== null),
  };
}

function seedOf(value: string | undefined): string | undefined {
  if (value === undefined || /^[0-9a-f]{40}$/.test(value)) return value;
  throw new UsageError('--seed takes a full 40-character commit SHA');
}

export type OrgDeps = GitHubOptions & { readonly templates?: () => Promise<Templates> };

/** `talos org` with a GitHub client and templates of the caller's choosing (tests). */
export function orgWith(deps: OrgDeps): Command {
  return async (argv, io) => {
    const [sub, ...rest] = argv;
    const { values } = parse(rest, {
      seed: { type: 'string' },
      ...RUN_FLAGS,
    });
    if (sub !== 'init' && sub !== 'pins') throw new UsageError(USAGE);
    const seed = seedOf(values.seed);
    const who = identities(io.env);
    const gh = github(await tokenFromEnvironment(io.env), deps);
    try {
      const report =
        sub === 'pins'
          ? await pins(gh, who)
          : await init(gh, who, await (deps.templates ?? loadTemplates)(), {
              seed,
              dryRun: values['dry-run'],
            });
      return printReport(io, report, values.json);
    } catch (error) {
      if (!(error instanceof GovernRefusal)) throw error;
      io.err(`talos org: ${error.message}\n`);
      return 1;
    }
  };
}

/**
 * `talos org`: the organisation's custom properties, the three channel rulesets that run the
 * gate pinned at a release, and the Talos repository's tag and self-test rulesets (and its
 * `channels` one with `TALOS_LOOKUP=channels`). `init --seed <sha>` seeds every pin from the first
 * release; afterwards the release jobs move them.
 * `pins` prints each channel's pin and its tag.
 */
export const org: Command = orgWith({});

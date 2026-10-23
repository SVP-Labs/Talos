import { type Command, type Io, parse, required, UsageError } from './io.js';
import { exec } from '../exec/exec.js';
import { github, type GitHubOptions, repoFromRemote, tokenFromEnvironment } from '../github/api.js';
import { identities } from '../github/identities.js';
import {
  agentProblem,
  claim,
  type ClaimResult,
  reasonProblem,
  release,
  type ReleaseResult,
  type Ticketing,
} from '../ticket/claim.js';
import { configAt, defaultBranch } from '../ticket/github.js';
import { TICKET_SCHEMA } from '../ticket/payload.js';
import { next, type NextResult } from '../ticket/queue.js';
import { sweepStaleClaims } from '../ticket/stale.js';
import { ticketStatus } from '../ticket/status.js';

/**
 * Exit codes of `talos ticket`:
 * - 0: done (claimed, released, status printed);
 * - 1: refused: the issue can't be claimed (closed, not `status/ready`, blocked, an epic…), or a
 *   PR is open from its branch so it can't be released;
 * - 2: an error (GitHub, configuration);
 * - 3: someone else holds the claim already (a usage error exits 3 too; the JSON tells them
 *   apart);
 * - 4: `next` claimed nothing: the open claims reach `agents.max_claims`, or no ticket in the
 *   queue could be claimed.
 */
export const TICKET_EXIT = { done: 0, refused: 1, taken: 3, nothing: 4 } as const;

const REPO = /^[\w.-]+\/[\w.-]+$/;

async function repoOf(value: string | undefined, io: Io): Promise<string> {
  const named = value ?? io.env.GITHUB_REPOSITORY ?? io.env.GH_REPO;
  if (named !== undefined && named !== '') {
    if (!REPO.test(named)) throw new UsageError(`--repo takes owner/name, not ${named}`);
    return named;
  }
  const remote = await exec('git', ['remote', 'get-url', 'origin'], { cwd: io.cwd });
  const fromRemote = remote.code === 0 ? repoFromRemote(remote.stdout) : undefined;
  if (fromRemote === undefined) throw new UsageError('no repository: pass --repo owner/name');
  return fromRemote;
}

function issueNumber(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value)) {
    throw new UsageError('an issue number is required');
  }
  return Number(value);
}

function checked(text: string, problem: (text: string) => string | undefined): string {
  const found = problem(text);
  if (found !== undefined) throw new UsageError(found);
  return text;
}

function exitOf(result: ClaimResult | ReleaseResult | NextResult): number {
  switch (result.result) {
    case 'refused': {
      return TICKET_EXIT.refused;
    }
    case 'taken': {
      return TICKET_EXIT.taken;
    }
    case 'max-claims':
    case 'empty': {
      return TICKET_EXIT.nothing;
    }
    default: {
      return TICKET_EXIT.done;
    }
  }
}

const USAGE =
  'usage: talos ticket claim <issue> --agent <id> | next --agent <id> | ' +
  'release <issue> --reason <text> | status <issue>   [--repo owner/name]';

type SubArgs = {
  readonly issue: string | undefined;
  readonly agent: string | undefined;
  readonly reason: string | undefined;
  readonly maxClaims: number;
};

async function runSub(
  t: Ticketing,
  sub: string,
  args: SubArgs,
): Promise<{ output: Record<string, unknown>; code: number }> {
  if (sub === 'status') {
    return { output: await ticketStatus(t, issueNumber(args.issue)), code: TICKET_EXIT.done };
  }
  if (sub === 'release') {
    const reason = checked(required(args.reason, 'reason'), reasonProblem);
    const result = await release(t, issueNumber(args.issue), reason);
    return { output: { issue: Number(args.issue), ...result }, code: exitOf(result) };
  }
  const agent = checked(required(args.agent, 'agent'), agentProblem);
  if (sub === 'claim') {
    const result = await claim(t, issueNumber(args.issue), agent);
    return { output: { issue: Number(args.issue), ...result }, code: exitOf(result) };
  }
  const swept = await sweepStaleClaims({ gh: t.gh, refs: t.gh }, t);
  const result = await next(t, agent, args.maxClaims);
  return { output: { ...result, swept: swept.released }, code: exitOf(result) };
}

/** `talos ticket` with a GitHub client of the caller's choosing (tests pass a fake fetch). */
export function ticketWith(options: GitHubOptions): Command {
  return async (argv, io) => {
    const [sub, ...rest] = argv;
    if (sub === undefined || !['claim', 'next', 'release', 'status'].includes(sub)) {
      throw new UsageError(USAGE);
    }
    const { values, positionals } = parse(
      rest,
      { agent: { type: 'string' }, reason: { type: 'string' }, repo: { type: 'string' } },
      true,
    );
    const repo = await repoOf(values.repo, io);
    const gh = github(await tokenFromEnvironment(io.env), options);
    const config = await configAt(gh, repo, await defaultBranch(gh, repo));
    const t: Ticketing = {
      gh,
      repo,
      prefix: config.prefix,
      who: identities(io.env),
      now: new Date(),
    };
    const { output, code } = await runSub(t, sub, {
      issue: positionals[0],
      agent: values.agent,
      reason: values.reason,
      maxClaims: config.agents.max_claims,
    });
    io.out(`${JSON.stringify({ schema: TICKET_SCHEMA, repo, ...output }, null, 2)}\n`);
    return code;
  };
}

/**
 * `talos ticket`: the claim protocol, for agents and people alike. Every subcommand prints one
 * JSON object (`talos.ticket/1`); `next` first releases claims idle for four hours.
 */
export const ticket: Command = ticketWith({});

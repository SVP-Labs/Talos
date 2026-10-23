import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type Command, type Io, parse, required, UsageError } from './io.js';
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
import { CLAIM_SCHEMA, TICKET_SCHEMA } from '../ticket/payload.js';
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
  const remote = await promisify(execFile)('git', ['remote', 'get-url', 'origin'], {
    cwd: io.cwd,
  }).catch(() => undefined);
  const fromRemote = remote === undefined ? undefined : repoFromRemote(remote.stdout);
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

/** A subcommand with its arguments checked, before anything touches GitHub. */
export type TicketRequest =
  | { readonly sub: 'claim'; readonly issue: number; readonly agent: string }
  | { readonly sub: 'next'; readonly agent: string }
  | { readonly sub: 'release'; readonly issue: number; readonly reason: string }
  | { readonly sub: 'status'; readonly issue: number };

export function ticketRequest(
  sub: string | undefined,
  args: {
    readonly issue: string | undefined;
    readonly agent: string | undefined;
    readonly reason: string | undefined;
  },
): TicketRequest {
  switch (sub) {
    case 'claim': {
      const agent = checked(required(args.agent, 'agent'), agentProblem);
      return { sub, issue: issueNumber(args.issue), agent };
    }
    case 'next': {
      return { sub, agent: checked(required(args.agent, 'agent'), agentProblem) };
    }
    case 'release': {
      const reason = checked(required(args.reason, 'reason'), reasonProblem);
      return { sub, issue: issueNumber(args.issue), reason };
    }
    case 'status': {
      return { sub, issue: issueNumber(args.issue) };
    }
    default: {
      throw new UsageError(USAGE);
    }
  }
}

type Outcome = (ClaimResult | ReleaseResult | NextResult) & { readonly issue?: number };

/**
 * `talos.claim/1`: a claimed ticket's fields at the top level, or `error` naming why there is
 * none (`claimed` exits 3, `none` and `max-claims` exit 4, `refused` exits 1).
 */
export function claimContract(outcome: Outcome): Record<string, unknown> {
  switch (outcome.result) {
    case 'claimed': {
      const { result: _result, ticket, ...rest } = outcome;
      return { schema: CLAIM_SCHEMA, ...rest, ...ticket };
    }
    case 'taken': {
      const { result: _result, ...rest } = outcome;
      return { schema: CLAIM_SCHEMA, error: 'claimed', ...rest };
    }
    case 'empty': {
      const { result: _result, ...rest } = outcome;
      return { schema: CLAIM_SCHEMA, error: 'none', ...rest };
    }
    case 'max-claims':
    case 'refused': {
      const { result, ...rest } = outcome;
      return { schema: CLAIM_SCHEMA, error: result, ...rest };
    }
    case 'released': {
      const { result: _result, ...rest } = outcome;
      return { schema: CLAIM_SCHEMA, released: true, ...rest };
    }
  }
}

async function runRequest(
  t: Ticketing,
  request: TicketRequest,
  maxClaims: number,
): Promise<{ output: Record<string, unknown>; code: number }> {
  switch (request.sub) {
    case 'status': {
      return { output: await ticketStatus(t, request.issue), code: TICKET_EXIT.done };
    }
    case 'release': {
      const result = await release(t, request.issue, request.reason);
      return { output: claimContract({ issue: request.issue, ...result }), code: exitOf(result) };
    }
    case 'claim': {
      const result = await claim(t, request.issue, request.agent);
      return { output: claimContract({ issue: request.issue, ...result }), code: exitOf(result) };
    }
    case 'next': {
      const swept = await sweepStaleClaims({ gh: t.gh, refs: t.gh }, t);
      const result = await next(t, request.agent, maxClaims);
      return { output: { ...claimContract(result), swept: swept.released }, code: exitOf(result) };
    }
  }
}

/** `talos ticket` with a GitHub client of the caller's choosing (tests pass a fake fetch). */
export function ticketWith(options: GitHubOptions): Command {
  return async (argv, io) => {
    const [sub, ...rest] = argv;
    const { values, positionals } = parse(
      rest,
      { agent: { type: 'string' }, reason: { type: 'string' }, repo: { type: 'string' } },
      true,
    );
    const request = ticketRequest(sub, {
      issue: positionals[0],
      agent: values.agent,
      reason: values.reason,
    });
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
    const { output, code } = await runRequest(t, request, config.agents.max_claims);
    io.out(`${JSON.stringify({ schema: TICKET_SCHEMA, ...output, repo }, null, 2)}\n`);
    return code;
  };
}

/**
 * `talos ticket`: the claim protocol, for agents and people alike. Every subcommand prints one
 * JSON object (`talos.ticket/1`); `next` first releases claims idle for four hours.
 */
export const ticket: Command = ticketWith({});

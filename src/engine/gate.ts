import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changesBetween } from './local.js';
import type { GatePlan } from './plan.js';
import { type Comparison, statusOf, type Verdict } from './verdict.js';
import { subjectFindings, ticketOf } from '../checks/process/commits.js';
import type { TalosConfig } from '../config/schema.js';
import type { Reported } from '../core/finding.js';
import { fingerprint, identity } from '../core/fingerprint.js';
import { parseGlossary } from '../docs/glossary.js';
import { type Git, parentOf } from '../repo/git.js';

/** The comparisons a plan implies: head against base, and each commit against its parent. */
export async function comparisonsFor(repo: Git, plan: GatePlan): Promise<Comparison[]> {
  const head: Comparison = {
    sha: plan.head,
    against: plan.base,
    tier: 'head',
    changes: await changesBetween(repo, plan.base, plan.head),
  };
  if (plan.mode === 'draft') return [head, { ...head, tier: 'commit' }];
  const inRange = new Set([plan.base, ...plan.commits]);
  const perCommit = await Promise.all(
    plan.commits.map(async (sha): Promise<Comparison> => {
      const parent = await parentOf(repo, sha);
      const against = inRange.has(parent) ? parent : plan.base;
      return { sha, against, tier: 'commit', changes: await changesBetween(repo, against, sha) };
    }),
  );
  return [head, ...perCommit];
}

async function glossaryAt(
  root: string,
  config: TalosConfig,
): Promise<ReturnType<typeof parseGlossary>> {
  try {
    return parseGlossary(await readFile(join(root, config.docs.glossary), 'utf8'));
  } catch {
    return [];
  }
}

/** The subject of every commit the gate judges. */
export async function commitFindings(
  repo: Git,
  plan: GatePlan,
  config: TalosConfig,
): Promise<(Reported & { readonly sha: string })[]> {
  const glossary = await glossaryAt(repo.root, config);
  const ticket = ticketOf(plan.branch, config.prefix);
  const shas = plan.mode === 'draft' ? [plan.head] : plan.commits;
  const findings = await Promise.all(
    shas.map(async (sha) => {
      const [subject = '', authorEmail = ''] = (
        await repo.run(['log', '-1', '--format=%s%n%ae', sha])
      ).split('\n');
      return subjectFindings({ sha, subject, authorEmail }, config.prefix, ticket, glossary).map(
        (f) => ({
          ...f,
          sha,
          check: 'process/commits',
          policy: f.policy ?? 'always',
          fingerprint: fingerprint(f.rule, identity(f, undefined)),
        }),
      );
    }),
  );
  return findings.flat();
}

const MAX_LISTED = 20;
const MAX_MESSAGE = 200;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The gate's compact verdict (`talos.verdict/1`): small enough to ride in an event, so one event
 * carries what an agent needs to act on without loading logs.
 */
export function compactVerdict(
  verdict: Verdict,
  context: { talos: string; repo?: string; pr?: number; mode: string; base: string; head: string },
): Record<string, unknown> {
  const byRule: Record<string, number> = {};
  for (const finding of verdict.blocking) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  const status = statusOf(verdict);
  return {
    schema: 'talos.verdict/1',
    talos: context.talos,
    repo: context.repo ?? null,
    pr: context.pr ?? null,
    mode: context.mode,
    base: context.base,
    head: context.head,
    status,
    counts: {
      blocking: verdict.blocking.length,
      existing: verdict.findings.length - verdict.blocking.length,
      faults: verdict.faults.length,
      byRule,
    },
    blocking: verdict.blocking.slice(0, MAX_LISTED).map((f) => ({
      sha: f.sha,
      rule: f.rule,
      why: f.why,
      file: f.location?.file ?? null,
      line: f.location?.line ?? null,
      message: clip(f.message, MAX_MESSAGE),
    })),
    faults: verdict.faults.slice(0, 5).map((f) => ({
      sha: f.sha,
      os: f.os,
      check: f.check,
      reason: clip(f.reason ?? '', 300),
    })),
    flaky: verdict.findings
      .filter((f) => f.rule === 'tests/flaky')
      .slice(0, MAX_LISTED)
      .map((f) => ({ id: f.key ?? f.message, file: f.location?.file ?? null })),
    truncated: verdict.blocking.length > MAX_LISTED || verdict.faults.length > 5,
  };
}

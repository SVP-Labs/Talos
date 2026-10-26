import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changesBetween } from './local.js';
import type { GatePlan } from './plan.js';
import { printedBytes, VERDICT_CAPS } from './verdict-caps.js';
import { type Comparison, type Located, statusOf, type Verdict } from './verdict.js';
import { mergeFinding, subjectFindings, ticketOf } from '../checks/process/commits.js';
import type { TalosConfig } from '../config/schema.js';
import type { Reported } from '../core/finding.js';
import { fingerprint, identity } from '../core/fingerprint.js';
import { parseGlossary } from '../docs/glossary.js';
import { DEPENDABOT, sameLogin } from '../github/identities.js';
import { type Git, parentsOf } from '../repo/git.js';

/**
 * The comparisons a plan implies: head against base, and each commit against its parent. A merge
 * commit has no one parent to be judged against, and a commit whose parent is outside the range
 * sits beside one, on a branch `main` was merged into: judged against the base it never had, it
 * would carry `main`'s changes reversed. Neither is compared; the merge's own finding asks for
 * the rebase after which every commit can be judged.
 */
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
    plan.commits.map(async (sha): Promise<Comparison[]> => {
      const [parent, ...others] = await parentsOf(repo, sha);
      if (parent === undefined || others.length > 0 || !inRange.has(parent)) return [];
      const changes = await changesBetween(repo, parent, sha);
      return [{ sha, against: parent, tier: 'commit', changes }];
    }),
  );
  return [head, ...perCommit.flat()];
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
  const dependabotVouched = plan.mode === 'merge-group' || sameLogin(plan.author, DEPENDABOT);
  const shas = plan.mode === 'draft' ? [plan.head] : plan.commits;
  const findings = await Promise.all(
    shas.map(async (sha) => {
      const [subject = '', authorEmail = '', parents = ''] = (
        await repo.run(['log', '-1', '--format=%s%n%ae%n%P', sha])
      ).split('\n');
      const facts = { sha, subject, authorEmail, dependabotVouched };
      const merged = parents.trim().split(' ').length > 1;
      const found = merged
        ? [mergeFinding(sha)]
        : subjectFindings(facts, config.prefix, ticket, glossary);
      return found.map((f) => ({
        ...f,
        sha,
        check: 'process/commits',
        policy: f.policy ?? 'always',
        fingerprint: fingerprint(f.rule, identity(f, undefined)),
      }));
    }),
  );
  return findings.flat();
}

const CAP = VERDICT_CAPS;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Every blocking finding counted by its rule as listed, for the rules with the most, ties by
 * name; rules that clip alike count together.
 */
function countedByRule(blocking: readonly Located[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const finding of blocking) {
    const rule = clip(finding.rule, CAP.rule);
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  const most = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  return Object.fromEntries(most.slice(0, CAP.rules));
}

type Listed = { readonly blocking: readonly unknown[]; readonly flaky: readonly unknown[] };

/**
 * The verdict with its lists cut, flaky tests first, until it fits {@link VERDICT_CAPS}' bytes;
 * what stays outside the lists is capped so that it always fits.
 */
function fitted<T extends Listed & { readonly truncated: boolean }>(verdict: T): T {
  let fit = verdict;
  while (printedBytes(fit) > CAP.bytes && fit.flaky.length + fit.blocking.length > 0) {
    fit =
      fit.flaky.length > 0
        ? { ...fit, flaky: fit.flaky.slice(0, -1) }
        : { ...fit, blocking: fit.blocking.slice(0, -1), truncated: true };
  }
  return fit;
}

/**
 * The gate's compact verdict (`talos.verdict/1`): small enough to ride in an event, so one event
 * carries what an agent needs to act on without loading logs.
 */
export function compactVerdict(
  verdict: Verdict,
  context: { talos: string; repo?: string; pr?: number; mode: string; base: string; head: string },
): Record<string, unknown> {
  const status = statusOf(verdict);
  return fitted({
    schema: 'talos.verdict/1',
    talos: clip(context.talos, CAP.talos),
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
      byRule: countedByRule(verdict.blocking),
    },
    blocking: verdict.blocking.slice(0, CAP.listed).map((f) => ({
      sha: f.sha,
      rule: clip(f.rule, CAP.rule),
      why: f.why,
      file: f.location === undefined ? null : clip(f.location.file, CAP.path),
      line: f.location?.line ?? null,
      message: clip(f.message, CAP.message),
    })),
    faults: verdict.faults.slice(0, CAP.faults).map((f) => ({
      sha: f.sha,
      os: f.os,
      check: clip(f.check, CAP.check),
      reason: clip(f.reason ?? '', CAP.reason),
    })),
    flaky: verdict.findings
      .filter((f) => f.rule === 'tests/flaky')
      .slice(0, CAP.listed)
      .map((f) => ({
        id: clip(f.key ?? f.message, CAP.test),
        file: f.location === undefined ? null : clip(f.location.file, CAP.path),
      })),
    truncated: verdict.blocking.length > CAP.listed || verdict.faults.length > CAP.faults,
  });
}

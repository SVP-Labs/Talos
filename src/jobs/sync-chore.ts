import { DRIFT_CHECK, nameable } from './debt-issues.js';
import type { DebtReport } from './debt-report.js';
import {
  fileIssue,
  type IssueDraft,
  marker,
  type TalosIssue,
  talosIssues,
} from './talos-issues.js';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import { LABEL, looksClaimed } from '../ticket/labels.js';
import { affectedPaths } from '../ticket/sections.js';

/** The generated copies on the default branch that lag the enforced Talos version. */
export function staleCopies(report: DebtReport): string[] {
  const files = report.findings
    .filter((f) => f.check === DRIFT_CHECK)
    .flatMap((f) => (f.file !== null && nameable(f.file) ? [f.file] : []));
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

/**
 * The one sync chore: regenerate the stale copies. Its Affected areas lists exactly them, which
 * is all such a PR may touch to land without the owner.
 */
export function syncChore(files: readonly string[]): IssueDraft {
  const body = [
    marker('sync', { files: String(files.length) }),
    '',
    '### Goal',
    '',
    'Bring the generated tool configs back in line with the Talos version this repository ' +
      'enforces, so editors show the rules the gate applies.',
    '',
    '### Acceptance criteria',
    '',
    '- [ ] `talos configs` leaves nothing to change',
    '- [ ] `talos check` reports no `configs/drift` finding',
    '',
    '### Out of scope',
    '',
    'Project extension files and the rules themselves: only the generated copies change.',
    '',
    '### Affected areas',
    '',
    ...files.map((file) => `- \`${file}\``),
    '',
  ].join('\n');
  const n = files.length;
  return {
    title: `Sync ${n} generated config${n === 1 ? '' : 's'} with the enforced Talos version`,
    body,
    labels: [LABEL.chore, LABEL.sync, LABEL.ready, LABEL.eligible, LABEL.p3],
  };
}

export type SyncPlan =
  | { readonly action: 'none' | 'current' | 'claimed' }
  | { readonly action: 'create' }
  | { readonly action: 'update'; readonly issue: number };

/**
 * One open sync chore at a time. An unclaimed one follows the list of stale copies; a claimed one
 * is left alone, so the scope doesn't move under whoever works it.
 */
export function syncPlan(files: readonly string[], existing: readonly TalosIssue[]): SyncPlan {
  if (files.length === 0) return { action: 'none' };
  const open = existing.find((i) => i.state === 'open');
  if (open === undefined) return { action: 'create' };
  const listed = affectedPaths(open.body).sort((a, b) => a.localeCompare(b));
  if (listed.length === files.length && listed.every((f, i) => f === files[i])) {
    return { action: 'current' };
  }
  return looksClaimed(open.labels)
    ? { action: 'claimed' }
    : { action: 'update', issue: open.number };
}

export async function keepSyncChore(
  gh: GitHub,
  at: { readonly repo: string; readonly who: Identities },
  report: DebtReport,
): Promise<SyncPlan> {
  const files = staleCopies(report);
  const plan = syncPlan(files, await talosIssues(gh, at, LABEL.sync, 'sync'));
  const draft = syncChore(files);
  if (plan.action === 'create') await fileIssue(gh, at.repo, draft);
  if (plan.action === 'update') {
    await gh.request('PATCH', `repos/${at.repo}/issues/${plan.issue}`, {
      body: { title: draft.title, body: draft.body },
    });
  }
  return plan;
}

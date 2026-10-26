import { isTestOf } from './testfiles.js';
import type { IssueEvent, PullFile } from './types.js';
import { sameLogin } from '../github/identities.js';
import { LABEL, typeLabelsOf } from '../ticket/labels.js';
import { affectedPaths } from '../ticket/sections.js';

/** The issue types whose PRs may land without the owner, inside their named files. */
const UNATTENDED_TYPES: readonly string[] = [LABEL.chore, LABEL.deadCode, LABEL.debtOther];

/** Whether an issue of this type may land without the owner, inside its named files. */
export function isUnattended(type: string | undefined): boolean {
  return type !== undefined && UNATTENDED_TYPES.includes(type);
}

const DEBT_TYPES: readonly string[] = [LABEL.deadCode, LABEL.debtOther];

/** The one type label an issue carries, when it carries exactly one. */
export function typeOf(labels: readonly string[]): string | undefined {
  const types = typeLabelsOf(labels);
  return types.length === 1 ? types[0] : undefined;
}

/** Who last set a label: a person, Talos's reviewer App, someone else, or nobody on record. */
export type LabelSetter = 'person' | 'reviewer' | 'other' | 'unknown';

export function labelSetter(
  events: readonly IssueEvent[],
  label: string,
  reviewer: string,
): LabelSetter {
  const last = events.filter((e) => e.event === 'labeled' && e.label === label).at(-1);
  if (last?.actor === undefined) return 'unknown';
  if (sameLogin(last.actor, reviewer)) return 'reviewer';
  return last.actorType === 'User' ? 'person' : 'other';
}

/** Every path a PR touches: each file's path, and the old path of a renamed one. */
export function touchedPaths(files: readonly PullFile[]): string[] {
  const paths = files.flatMap((f) =>
    f.previousPath === undefined || f.previousPath === f.path ? [f.path] : [f.previousPath, f.path],
  );
  return [...new Set(paths)];
}

/**
 * The touched paths an issue's Affected areas don't cover. They cover the files they name; a
 * debt issue's also cover those files' tests.
 */
export function outsideScope(paths: readonly string[], issueBody: string, type: string): string[] {
  const named = affectedPaths(issueBody);
  const withTests = DEBT_TYPES.includes(type);
  return paths.filter(
    (path) => !named.includes(path) && !(withTests && named.some((file) => isTestOf(path, file))),
  );
}

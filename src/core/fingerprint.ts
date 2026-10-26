import { createHash } from 'node:crypto';
import type { Finding } from './finding.js';

/** The most lines of a finding's span that go into its fingerprint. */
const MAX_SPAN = 200;

/** Collapses whitespace so reindenting or reflowing code keeps a finding's identity. */
export function normalise(code: string): string {
  return code.replaceAll(/\s+/g, ' ').trim();
}

/** The code a finding points at, or its key, or its message when it points at nothing. */
export function identity(finding: Finding, lines: readonly string[] | undefined): string {
  if (finding.key !== undefined) return finding.key;
  const location = finding.location;
  if (location === undefined || lines === undefined) return finding.message;
  const first = Math.max(location.line, 1);
  const last = Math.min(location.endLine ?? first, first + MAX_SPAN - 1, lines.length);
  const span = lines.slice(first - 1, last).join('\n');
  return normalise(span) || `${location.file}:empty`;
}

/** The rule plus a hash of the normalised code, never the path or line: moved code keeps it. */
export function fingerprint(rule: string, identityText: string): string {
  return createHash('sha256')
    .update(rule)
    .update('\0')
    .update(identityText)
    .digest('hex')
    .slice(0, 32);
}

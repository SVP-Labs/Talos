import { createHash } from 'node:crypto';
import type { GitHub } from '../github/api.js';
import type { Identities } from '../github/identities.js';
import { addLabels } from '../ticket/github.js';
import { clip } from '../ticket/payload.js';
import { type Issue, parseIssue, parseIssues } from '../ticket/schemas.js';

/**
 * The issues and comments Talos files for its own bookkeeping open with a hidden line in the
 * grammar of every machine-readable line Talos writes (the reviewer's `talos-review/1`, the
 * sweep's `talos-security/1`): `talos-<kind>/1` and `key=value` fields, here inside an HTML
 * comment so people reading the issue don't see it. Thea's hub reads both forms the same way,
 * and a later run finds its own work again by it: to update one comment in place, or to file an
 * issue only once.
 */
export type MarkerKind = 'debt' | 'flaky' | 'sync' | 'readiness';

export function marker(kind: MarkerKind, fields: Readonly<Record<string, string>> = {}): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  const head = `talos-${kind}/1`;
  return `<!-- ${[head, ...pairs].join(' ')} -->`;
}

const MARKER_LINE = /^talos-([a-z]+)\/1((?: [a-z]+=\S*)*)$/;

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** A first line without its HTML comment, when it is wrapped in one. */
function unwrapped(line: string): string {
  return line.startsWith('<!--') && line.endsWith('-->') ? line.slice(4, -3).trim() : line;
}

/**
 * The fields of the marker of `kind` on a body's first line, hidden or visible, or `undefined`
 * when there is none.
 */
export function readMarker(
  body: string,
  kind: MarkerKind,
): Readonly<Record<string, string>> | undefined {
  const match = MARKER_LINE.exec(unwrapped(body.split(/\r?\n/, 1)[0]?.trim() ?? ''));
  if (match?.[1] !== kind) return undefined;
  const fields: Record<string, string> = {};
  for (const pair of (match[2] ?? '').trim().split(' ').filter(Boolean)) {
    const [key = '', value = ''] = pair.split('=');
    const text = decoded(value);
    if (key !== '' && text !== undefined) fields[key] = text;
  }
  return fields;
}

/** A short, stable hash for a marker: the same input always gives the same 12 hex digits. */
export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Text from a tool or a repository, made safe for an issue: one line, clipped, inside a code
 * span, so no `@mention` pings anyone, no HTML renders and no Markdown table breaks.
 */
export function codeSpan(text: string, max = 200): string {
  const line = text
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll('`', "'")
    .replaceAll('|', String.raw`\|`);
  if (line === '') return '—';
  return `\`${clip(line, max)}\``;
}

export type TalosIssue = Issue & { readonly fields: Readonly<Record<string, string>> };

/**
 * Every issue, open or closed, carrying `label` that Talos's reviewer App filed with a marker
 * of `kind`. Anyone else's issue is ignored, even with the same marker.
 */
export async function talosIssues(
  gh: GitHub,
  at: { readonly repo: string; readonly who: Identities },
  label: string,
  kind: MarkerKind,
): Promise<TalosIssue[]> {
  const data = await gh.paginate<unknown>(
    `repos/${at.repo}/issues?state=all&labels=${encodeURIComponent(label)}`,
  );
  return parseIssues(data).flatMap((issue) => {
    if (issue.isPull || issue.author !== at.who.reviewer) return [];
    const fields = readMarker(issue.body, kind);
    return fields === undefined ? [] : [{ ...issue, fields }];
  });
}

export type IssueDraft = {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
};

/**
 * Files an issue with its labels. Labels set on creation count as set by the creator, which is
 * how the review tells a type label Talos set from one an agent changed.
 */
export async function fileIssue(gh: GitHub, repo: string, draft: IssueDraft): Promise<number> {
  const created = parseIssue(
    await gh.request<unknown>('POST', `repos/${repo}/issues`, {
      body: { title: draft.title, body: draft.body, labels: [...draft.labels] },
    }),
  );
  const missing = draft.labels.filter((label) => !created.labels.includes(label));
  await addLabels(gh, repo, created.number, missing);
  return created.number;
}

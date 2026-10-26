import { posix } from 'node:path';

/**
 * The words adoption writes on GitHub: the bootstrap issue (a chore in the issue form's shape, so
 * issue readiness reads it) and the bootstrap PR (the PR template's sections, closing the issue).
 */

/** Marks the bootstrap issue, so a rerun finds it instead of filing another. */
export const ADOPT_MARKER = '<!-- talos-adopt -->';

const BRIEF_NAME = /^(\d{8})-([a-z0-9][a-z0-9-]*)\.md$/;

export function slugify(text: string): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  let slug = '';
  for (const word of words) {
    const longer = slug === '' ? word : `${slug}-${word}`;
    if (longer.length > 60) break;
    slug = longer;
  }
  return slug === '' ? 'brief' : slug;
}

function firstHeading(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.startsWith('# '));
  const heading = line?.slice(2).trim();
  return heading === '' ? undefined : heading;
}

/** `YYYYMMDD` of a date, in UTC. */
export function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * Where a given brief goes: `<briefs>/<YYYYMMDD>-<slug>.md`. A file already named that way keeps
 * its name, so every step of adoption agrees on it; otherwise the slug comes from its first
 * heading, else its file name, and the date is today's.
 */
export function briefPath(briefs: string, fileName: string, text: string, now: Date): string {
  const base = posix.basename(fileName.replaceAll('\\', '/'));
  if (BRIEF_NAME.test(base)) return posix.join(briefs, base);
  const slug = slugify(firstHeading(text) ?? base.replace(/\.md$/i, ''));
  return posix.join(briefs, `${dateStamp(now)}-${slug}.md`);
}

export function bootstrapTitle(name: string): string {
  return `Bring ${name} under Talos`;
}

/** The commit subject and PR title: `[P-N]: Bring <Name> under Talos`. */
export function bootstrapSubject(prefix: string, issue: number, name: string): string {
  return `[${prefix}-${issue}]: ${bootstrapTitle(name)}`;
}

export type BootstrapText = {
  readonly name: string;
  readonly brief: string | undefined;
  readonly scaffold: boolean;
};

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

export function bootstrapIssueBody(text: BootstrapText): string {
  const criteria = [
    '[ ] `talos.yml` names every component, and `talos check` runs on each',
    "[ ] The generated tool configs are committed, with the project's own settings moved into " +
      'their extension files and `talos.yml`',
    '[ ] `CLAUDE.md`, the issue forms, the PR template, `.github/dependabot.yml` and the package ' +
      "managers' supply-chain settings are in place",
    ...(text.brief === undefined ? [] : [`[ ] The brief is at \`${text.brief}\``]),
    ...(text.scaffold ? ["[ ] Scaffold's scripts, justfile and language folders are gone"] : []),
  ];
  const areas = [
    '`talos.yml`',
    '`CLAUDE.md`',
    '`.github/`',
    'the tool configs and dependency manifests of each component',
    "the repository's git, package-manager and scanner settings",
    ...(text.brief === undefined ? [] : [`\`${text.brief}\``]),
  ];
  return [
    '### Goal',
    '',
    `Bring ${text.name} under Talos: its settings, generated configs, agent instructions, issue ` +
      'forms and Dependabot settings, in one PR the owner approves.',
    '',
    '### Acceptance criteria',
    '',
    bullets(criteria),
    '',
    '### Out of scope',
    '',
    'Fixing findings: they stay as debt, filed weekly from the findings on the default branch.',
    '',
    '### Affected areas',
    '',
    bullets(areas),
    '',
    ADOPT_MARKER,
    '',
  ].join('\n');
}

export type PullText = BootstrapText & {
  readonly issue: number;
  /** How many files the PR changes. */
  readonly changed: number;
};

export function bootstrapPullBody(text: PullText): string {
  const brief = text.brief === undefined ? '' : ` Its brief is \`${text.brief}\`.`;
  return [
    `Closes #${text.issue}`,
    '',
    '## Problem',
    '',
    `${text.name} isn't governed by Talos yet: no \`talos.yml\`, no generated configs, and its ` +
      `issues don't follow the ticket format.${brief}`,
    '',
    '## Discussion',
    '',
    '`talos adopt` writes files only; the repository settings came first, from `talos govern`. ' +
      'Existing open issues are labelled `legacy`, so issue readiness leaves them alone.',
    '',
    '## Solution',
    '',
    `Changes ${text.changed} file(s): \`talos.yml\` from the manifests, the generated tool ` +
      'configs, `CLAUDE.md`, the issue forms, the PR template, Dependabot settings with a ' +
      "one-day cooldown and the package managers' supply-chain settings; the project's own " +
      'tool and scanner settings move into the extension files and `talos.yml`' +
      `${text.scaffold ? "; Scaffold's scripts, justfile and language folders go" : ''}.`,
    '',
  ].join('\n');
}

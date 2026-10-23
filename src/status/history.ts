import type { GitHub } from '../github/api.js';
import { pullsForCommit } from '../github/pulls.js';
import type { Git } from '../repo/git.js';

export const SECTIONS = ['problem', 'discussion', 'solution'] as const;
export type Section = (typeof SECTIONS)[number];
export type Sections = Readonly<Record<Section, string | null>>;

const HEADING = /^ {0,3}(#{1,6})[ \t](.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;

type Heading = { readonly level: number; readonly section: Section | undefined };

function headingOf(line: string): Heading | undefined {
  const match = HEADING.exec(line);
  if (match?.[1] === undefined) return undefined;
  const words = (match[2] ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z]+/g, ' ')
    .trim();
  return { level: match[1].length, section: SECTIONS.find((section) => section === words) };
}

function opened(found: Map<Section, string[]>, heading: Heading): Heading {
  if (heading.section !== undefined && !found.has(heading.section)) found.set(heading.section, []);
  return heading;
}

function joined(lines: readonly string[] | undefined): string | null {
  const value = lines?.join('\n').trim() ?? '';
  return value === '' ? null : value;
}

/**
 * The Problem, Discussion and Solution sections of a PR body: the text under a heading of that
 * name, up to the next heading of the same or a higher level. HTML comments (a template's
 * guidance) are dropped; an empty section is `null`.
 */
export function historySections(body: string): Sections {
  const found = new Map<Section, string[]>();
  let current: Heading = { level: 0, section: undefined };
  let fenced = false;
  const text = body.replaceAll(/<!--[\s\S]*?-->/g, '').replaceAll('\r\n', '\n');
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : headingOf(line);
    const ends = current.section === undefined || (heading?.level ?? 7) <= current.level;
    if (heading !== undefined && ends) {
      current = opened(found, heading);
    } else if (current.section !== undefined) {
      found.get(current.section)?.push(line);
    }
  }
  return {
    problem: joined(found.get('problem')),
    discussion: joined(found.get('discussion')),
    solution: joined(found.get('solution')),
  };
}

export type WhyEntry = Sections & {
  readonly number: number;
  readonly title: string;
  readonly merged: string | null;
  readonly url: string;
};

export type WhyQuery = {
  readonly gh: GitHub;
  readonly repo: string;
  /** How many PRs to find, newest first. */
  readonly limit: number;
};

/** Commits that last changed `path` are read this far back at most. */
export const MAX_COMMITS = 30;

/** The commits that changed `path`, newest first, following a file across renames. */
export async function commitsFor(git: Git, path: string, isFile: boolean): Promise<string[]> {
  const follow = isFile ? ['--follow'] : [];
  const out = await git.run(['log', '--format=%H', `-n${MAX_COMMITS}`, ...follow, '--', path]);
  return out.split('\n').filter((line) => /^[0-9a-f]{40}$/.test(line));
}

/** The merged PRs behind the commits that last changed a path, newest first, one per PR. */
export async function whyFor(query: WhyQuery, commits: readonly string[]): Promise<WhyEntry[]> {
  const entries = new Map<number, WhyEntry>();
  for (const sha of commits) {
    if (entries.size >= query.limit) break;
    const pulls = await pullsForCommit(query.gh, query.repo, sha);
    for (const pull of pulls) {
      if (pull.mergedAt === null || entries.has(pull.number) || entries.size >= query.limit) {
        continue;
      }
      entries.set(pull.number, {
        number: pull.number,
        title: pull.title,
        merged: pull.mergedAt,
        url: pull.url,
        ...historySections(pull.body),
      });
    }
  }
  return [...entries.values()];
}

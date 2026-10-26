import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { type Command, parse, UsageError } from './io.js';
import { exec } from '../exec/exec.js';
import { github, tokenFromEnvironment } from '../github/api.js';
import { currentRepository, isRepoName } from '../github/remote.js';
import { git } from '../repo/git.js';
import { commitsFor, SECTIONS, type WhyEntry, whyFor } from '../status/history.js';
import { clip } from '../status/schema.js';

const MAX_LIMIT = 20;
/** A section is the answer itself, so it gets more room than a message. */
const MAX_SECTION = 500;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function limitOf(value: string | undefined): number {
  const limit = Number(value ?? '3');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new UsageError(`--limit takes 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function entryText(entry: WhyEntry): string {
  const lines = [`#${entry.number} ${entry.title} (merged ${entry.merged?.slice(0, 10) ?? '?'})`];
  for (const section of SECTIONS) {
    const text = entry[section];
    if (text !== null) lines.push(`  ${section}:`, ...text.split('\n').map((l) => `    ${l}`));
  }
  if (SECTIONS.every((section) => entry[section] === null)) {
    lines.push('  (no Problem, Discussion or Solution section)');
    if (entry.summary !== null) lines.push(...entry.summary.split('\n').map((l) => `    ${l}`));
  }
  return lines.join('\n');
}

function compact(entry: WhyEntry): Record<string, unknown> {
  return {
    number: entry.number,
    title: clip(entry.title, 200),
    merged: entry.merged,
    problem: entry.problem === null ? null : clip(entry.problem, MAX_SECTION),
    discussion: entry.discussion === null ? null : clip(entry.discussion, MAX_SECTION),
    solution: entry.solution === null ? null : clip(entry.solution, MAX_SECTION),
    summary: entry.summary === null ? null : clip(entry.summary, MAX_SECTION),
  };
}

/**
 * `talos why <path> [--limit N] [--repo owner/name] [--json]`: the merged PRs that last changed a
 * path, with each one's Problem, Discussion and Solution, from `git log` and the API.
 */
export const why: Command = async (argv, io) => {
  const { values, positionals } = parse(
    argv,
    {
      limit: { type: 'string' },
      repo: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    true,
  );
  const [target] = positionals;
  if (target === undefined || positionals.length > 1) throw new UsageError('give one path');
  if (values.repo !== undefined && !isRepoName(values.repo)) {
    throw new UsageError(`--repo takes owner/name, not "${values.repo}"`);
  }
  const limit = limitOf(values.limit);
  const absolute = isAbsolute(target) ? target : join(io.cwd, target);
  const path = relative(io.cwd, absolute).split(sep).join('/') || '.';
  const repo = values.repo ?? (await currentRepository(io.env, io.cwd, exec));
  if (repo === undefined) throw new UsageError('no GitHub repository here: pass --repo owner/name');
  const clone = git(exec, io.cwd);
  const commits = await commitsFor(clone, path, await isFile(absolute));
  const gh = github(await tokenFromEnvironment(io.env));
  const entries = await whyFor({ gh, repo, limit }, commits);
  if (values.json) {
    const result = {
      schema: 'talos.why/1',
      repo,
      path,
      commits: commits.length,
      prs: entries.map(compact),
    };
    io.out(`${JSON.stringify(result)}\n`);
  } else {
    io.out(
      entries.length === 0
        ? `no merged PR changed ${path}\n`
        : `${entries.map(entryText).join('\n\n')}\n`,
    );
  }
  return 0;
};

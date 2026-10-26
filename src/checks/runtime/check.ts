import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessRuntimes, SECURITY_RULE } from './assess.js';
import { declaredRuntimes, isDeclaringFile } from './declarations.js';
import { loadFeeds } from './feeds.js';
import { defaultFetcher, type Fetcher } from './fetchers.js';
import type { ExceptionEntry } from '../../config/schema.js';
import { APPLIES, type Check, EngineError, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

export type RuntimeOptions = {
  readonly fetcher: Fetcher;
  /** `YYYY-MM-DD`, in UTC. */
  readonly today: string;
  /** `supply_chain.exceptions`: an entry `<runtime> <version>` excuses that security finding. */
  readonly exceptions?: Readonly<Record<string, ExceptionEntry>>;
};

function normalisedKey(key: string): string {
  return key.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

/** Drops each security finding an unexpired exception names. */
export function excepted(
  findings: readonly Finding[],
  exceptions: Readonly<Record<string, ExceptionEntry>>,
  today: string,
): Finding[] {
  const live = new Set(
    Object.entries(exceptions)
      .filter(([, entry]) => entry.expires >= today)
      .map(([key]) => normalisedKey(key)),
  );
  return findings.filter(
    (f) => f.rule !== SECURITY_RULE || f.key === undefined || !live.has(normalisedKey(f.key)),
  );
}

/**
 * The runtime findings for a repository's files, by repository-relative path: what the gate's
 * check reports and what the hourly sweep files issues from.
 */
export async function runtimeFindings(
  files: ReadonlyMap<string, string>,
  options: RuntimeOptions,
): Promise<Finding[]> {
  const declarations = declaredRuntimes(files);
  if (declarations.length === 0) return [];
  const feeds = await loadFeeds(declarations, options.fetcher);
  const findings = assessRuntimes(declarations, feeds, options.today);
  return excepted(findings, options.exceptions ?? {}, options.today);
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readAll(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const texts = await Promise.all(
    paths.map(async (path) => {
      try {
        return await readFile(join(root, path), 'utf8');
      } catch {
        throw new EngineError(`${path} could not be read`);
      }
    }),
  );
  return new Map(paths.map((path, index): [string, string] => [path, texts[index] ?? '']));
}

export type CheckOptions = {
  readonly fetcher?: () => Fetcher;
  readonly today?: () => string;
};

/**
 * `runtime/runtimes`: every runtime the repository declares, against its vendor's release feed.
 * A repository without a Dockerfile is checked through its version files and `tools.lock`.
 */
export function runtimesCheck(options: CheckOptions = {}): Check {
  return {
    id: 'runtime/runtimes',
    tier: 'head',
    scope: 'repo',
    title: "runtimes against their vendors' release feeds",
    applies: (ctx) =>
      ctx.facts.files.some((file) => isDeclaringFile(file))
        ? APPLIES
        : skip('no Dockerfile, runtime version file or tools.lock declares a runtime'),
    run: async (ctx) => {
      const files = await readAll(
        ctx.root,
        ctx.facts.files.filter((file) => isDeclaringFile(file)),
      );
      return runtimeFindings(files, {
        fetcher: (options.fetcher ?? defaultFetcher)(),
        today: (options.today ?? utcToday)(),
        exceptions: ctx.config.supply_chain.exceptions,
      });
    },
  };
}

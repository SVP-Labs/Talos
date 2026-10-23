import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { generatedHeader } from '../../configs/header.js';
import { APPLIES, type Check, type CheckContext, EngineError, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { Generated } from '../../core/pack.js';
import type { RepoFacts } from '../../repo/facts.js';

export const SEMGREPIGNORE = '.semgrepignore';

/** The registry's security rule sets every repository runs, whatever its languages. */
const ALWAYS = ['p/default', 'p/security-audit', 'p/owasp-top-ten', 'p/secrets'];

/** The rule sets for what a repository has. */
const BY_FILES: readonly { readonly configs: readonly string[]; readonly globs: string[] }[] = [
  {
    configs: ['p/javascript', 'p/typescript', 'p/nodejs'],
    globs: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
  },
  { configs: ['p/react'], globs: ['**/*.{jsx,tsx}'] },
  { configs: ['p/python'], globs: ['**/*.py'] },
  { configs: ['p/php', 'p/phpcs-security-audit'], globs: ['**/*.php'] },
  { configs: ['p/rust'], globs: ['**/*.rs'] },
  { configs: ['p/dockerfile'], globs: ['**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile'] },
  {
    configs: ['p/docker-compose'],
    globs: ['**/compose.{yml,yaml}', '**/docker-compose*.{yml,yaml}'],
  },
  { configs: ['p/github-actions'], globs: ['.github/workflows/*.{yml,yaml}'] },
  { configs: ['p/terraform'], globs: ['**/*.tf'] },
];

/** The rule sets a repository runs: the security sets, and each of its languages' and tools'. */
export function semgrepConfigs(facts: RepoFacts): string[] {
  const own = BY_FILES.filter((set) => facts.has(...set.globs)).flatMap((set) => set.configs);
  return [...ALWAYS, ...own];
}

/**
 * Without a `.semgrepignore`, Semgrep skips tests and other paths by default; this one skips
 * only what `talos.yml` excludes, anchored at the root, besides what git ignores.
 */
export function renderSemgrepignore(exclude: readonly string[], version: string): string {
  return [
    generatedHeader('#', version).trimEnd(),
    "# Semgrep skips what git ignores and talos.yml's exclude, nothing more.",
    ...exclude.map((entry) => `/${entry.replace(/^\/+/, '')}`),
    '',
  ].join('\n');
}

export const semgrepignore: Generated = {
  path: SEMGREPIGNORE,
  scope: 'repo',
  applies: () => true,
  render: (ctx) => renderSemgrepignore(ctx.config.exclude, ctx.version),
};

const result = z.looseObject({
  check_id: z.string(),
  path: z.string(),
  start: z.looseObject({ line: z.number(), col: z.number().optional() }),
  end: z.looseObject({ line: z.number() }),
  extra: z.looseObject({
    message: z.string().default(''),
    metadata: z
      .looseObject({ shortlink: z.string().optional(), source: z.string().optional() })
      .default({}),
  }),
});

const output = z.looseObject({
  results: z.array(result).default([]),
  errors: z
    .array(z.looseObject({ level: z.string().default('error'), message: z.string().default('') }))
    .default([]),
});

/** A rule's message, cut to its first sentence and one line. */
export function firstSentence(message: string): string {
  const flat = message.replaceAll(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](?:\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

/** Semgrep's JSON output; its errors at level `error` mean the scan can't be trusted. */
export function parseSemgrep(text: string): Finding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError("Semgrep's report is not JSON");
  }
  const parsed = output.safeParse(raw);
  if (!parsed.success) throw new EngineError("Semgrep's report is not in the expected form");
  const fatal = parsed.data.errors.find((error) => error.level === 'error');
  if (fatal !== undefined) throw new EngineError(`Semgrep failed: ${firstSentence(fatal.message)}`);
  return parsed.data.results.map((found) => {
    const docs = found.extra.metadata.shortlink ?? found.extra.metadata.source;
    return {
      rule: `semgrep/${found.check_id}`,
      message: firstSentence(found.extra.message) || `Semgrep's rule ${found.check_id} matched.`,
      location: {
        file: found.path,
        line: found.start.line,
        endLine: found.end.line,
        ...(found.start.col === undefined ? {} : { column: found.start.col }),
      },
      ...(docs === undefined ? {} : { docs }),
    };
  });
}

async function scan(ctx: CheckContext): Promise<Finding[]> {
  const tool = await ctx.tools.path('semgrep');
  const report = join(ctx.scratch, 'semgrep.json');
  const args = [
    'scan',
    '--metrics=off',
    '--disable-version-check',
    '--quiet',
    '--json',
    `--output=${report}`,
    ...semgrepConfigs(ctx.facts).map((config) => `--config=${config}`),
    ...ctx.config.exclude.map((entry) => `--exclude=/${entry.replace(/^\/+/, '')}`),
    '.',
  ];
  const env = { SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' };
  const run = await ctx.exec(tool, args, { cwd: ctx.root, env });
  const text = await readFile(report, 'utf8').catch(() => undefined);
  const findings = text === undefined ? undefined : parseSemgrep(text);
  if (findings !== undefined && run.code === 0) return findings;
  const detail = run.stderr.trim().split('\n').at(-1) ?? '';
  throw new EngineError(`semgrep exited ${run.code}: ${detail === '' ? 'no report' : detail}`);
}

/**
 * Semgrep's registry rules for security, the repository's languages, Docker, Compose and
 * GitHub Actions. They come from the registry on each run, so a new rule can fail a change that
 * passed yesterday; its base commit fails it too, so the finding is debt, not new.
 */
export function semgrepCheck(): Check {
  return {
    id: 'security/semgrep',
    tier: 'head',
    scope: 'repo',
    title: "Semgrep's security rules for the repository's languages and tools",
    applies: (ctx) => (ctx.facts.files.length > 0 ? APPLIES : skip('the repository is empty')),
    run: scan,
  };
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { generatedHeader } from '../../configs/header.js';
import { APPLIES, type Check, type CheckContext, EngineError, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { Generated } from '../../core/pack.js';
import type { RepoFacts } from '../../repo/facts.js';
import { isDockerfile } from '../infra/files.js';

export const SEMGREPIGNORE = '.semgrepignore';

/** The registry's security rule sets every repository runs, whatever its languages. */
const ALWAYS = ['p/default', 'p/security-audit', 'p/owasp-top-ten', 'p/secrets'];

/** Rule sets, and whether a repository has what they are for. */
type RuleSets = {
  readonly configs: readonly string[];
  readonly present: (facts: RepoFacts) => boolean;
};

const having =
  (...globs: string[]) =>
  (facts: RepoFacts): boolean =>
    facts.has(...globs);

/** The rule sets for what a repository has. */
const BY_FILES: readonly RuleSets[] = [
  {
    configs: ['p/javascript', 'p/typescript', 'p/nodejs'],
    present: having('**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'),
  },
  { configs: ['p/react'], present: having('**/*.{jsx,tsx}') },
  { configs: ['p/python'], present: having('**/*.py') },
  { configs: ['p/php', 'p/phpcs-security-audit'], present: having('**/*.php') },
  { configs: ['p/rust'], present: having('**/*.rs') },
  { configs: ['p/dockerfile'], present: (facts) => facts.files.some((file) => isDockerfile(file)) },
  {
    configs: ['p/docker-compose'],
    present: having('**/compose.{yml,yaml}', '**/docker-compose*.{yml,yaml}'),
  },
  { configs: ['p/github-actions'], present: having('.github/workflows/*.{yml,yaml}') },
  { configs: ['p/terraform'], present: having('**/*.tf') },
];

/**
 * Registry rules that judge what a Talos check already decides, by another measure: Semgrep's
 * pnpm rule asks for a longer minimum release age than the one day every SVP-Labs repository
 * waits, and its Dependabot rule for a cooldown of seven days where each Dependabot entry waits
 * that same day. `supply/settings` checks both, the cooldown on every entry included.
 */
const EXCLUDED_RULES: readonly string[] = [
  'package_managers.pnpm.pnpm-missing-minimum-release-age.pnpm-minimum-release-age',
  'package_managers.dependabot.dependabot-missing-cooldown.dependabot-missing-cooldown',
];

/** The rule sets a repository runs: the security sets, and each of its languages' and tools'. */
export function semgrepConfigs(facts: RepoFacts): string[] {
  const own = BY_FILES.filter((set) => set.present(facts)).flatMap((set) => set.configs);
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

/** How many characters of file names one scan is given, well inside any command line's limit. */
const TARGET_CHARS = 100_000;

/** The files in runs whose names fit one command line each, in order. */
function targetBatches(files: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const file of files) {
    if (current.length > 0 && length + file.length + 1 > TARGET_CHARS) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += file.length + 1;
  }
  return current.length === 0 ? out : [...out, current];
}

async function scanFiles(
  ctx: CheckContext,
  targets: readonly string[],
  report: string,
): Promise<Finding[]> {
  const tool = await ctx.tools.path('semgrep');
  const args = [
    'scan',
    '--metrics=off',
    '--disable-version-check',
    '--quiet',
    '--json',
    `--output=${report}`,
    ...semgrepConfigs(ctx.facts).map((config) => `--config=${config}`),
    ...EXCLUDED_RULES.map((rule) => `--exclude-rule=${rule}`),
    ...ctx.config.exclude.map((entry) => `--exclude=/${entry.replace(/^\/+/, '')}`),
    ...targets,
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
 * Semgrep is given the files the run judges, by name: given a directory it would also scan what
 * the checkout holds beyond them, such as a tool's sandbox copy of the sources or untracked files.
 */
async function scan(ctx: CheckContext): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const [index, targets] of targetBatches(ctx.facts.files).entries()) {
    const report = join(ctx.scratch, `semgrep-${index}.json`);
    findings.push(...(await scanFiles(ctx, targets, report)));
  }
  return findings;
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

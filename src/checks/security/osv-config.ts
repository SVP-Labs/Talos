import type { TalosConfig } from '../../config/schema.js';
import { generatedHeader } from '../../configs/header.js';
import type { ApplyContext } from '../../core/check.js';
import type { Generated } from '../../core/pack.js';
import type { RepoFacts } from '../../repo/facts.js';

export const OSV_CONFIG = 'osv-scanner.toml';

/** The lockfiles osv-scanner reads, by file name. */
const OSV_LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'uv.lock',
  'poetry.lock',
  'pdm.lock',
  'Pipfile.lock',
  'requirements.txt',
  'composer.lock',
  'Cargo.lock',
  'go.mod',
  'Gemfile.lock',
];

/** Every tracked lockfile osv-scanner reads, sorted. */
export function osvLockfiles(facts: RepoFacts): string[] {
  return facts
    .matching(...OSV_LOCKFILES.map((name) => `**/${name}`))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `supply_chain.exceptions` as osv-scanner's ignore list. An exception stops applying on its
 * expiry date, when `ignoreUntil` stops ignoring.
 */
export function osvIgnores(config: TalosConfig): string {
  return Object.entries(config.supply_chain.exceptions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, exception]) =>
      [
        '[[IgnoredVulns]]',
        `id = ${JSON.stringify(id)}`,
        `ignoreUntil = ${exception.expires}`,
        `reason = ${JSON.stringify(exception.reason)}`,
        '',
      ].join('\n'),
    )
    .join('\n');
}

export function renderOsvConfig(config: TalosConfig, version: string): string {
  const header = [
    generatedHeader('#', version).trimEnd(),
    "# The exceptions are talos.yml's supply_chain.exceptions, each with a reason and an expiry.",
    '',
  ].join('\n');
  return `${header}${osvIgnores(config)}`;
}

export const osvConfig: Generated = {
  path: OSV_CONFIG,
  scope: 'repo',
  applies: (ctx: ApplyContext) => osvLockfiles(ctx.facts).length > 0,
  render: (ctx) => renderOsvConfig(ctx.config, ctx.version),
};

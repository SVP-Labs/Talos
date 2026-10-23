import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GITLEAKS_PROJECT, redefinitions, type Weakening } from './gitleaks-config.js';
import { defaultRuleIds } from './gitleaks.js';
import { OSV_CONFIG } from './osv-config.js';
import { gitleaksProject } from './secrets.js';
import { SEMGREPIGNORE } from './semgrep.js';
import { APPLIES, type Check, type CheckContext, skip } from '../../core/check.js';
import type { Finding, Location } from '../../core/finding.js';

/** The whole file, so a change to it touches the finding. */
async function wholeFile(ctx: CheckContext, file: string): Promise<Location> {
  const text = await readFile(join(ctx.root, file), 'utf8').catch(() => '');
  const lines = Math.max(1, text.replace(/\r?\n$/, '').split(/\r?\n/).length);
  return { file, line: 1, endLine: lines };
}

async function weaker(ctx: CheckContext, file: string, found: Weakening): Promise<Finding> {
  return {
    rule: 'config/weaker',
    key: `${file} ${found.key}`,
    message: `${file} ${found.how}; it may only tighten the base.`,
    location: await wholeFile(ctx, file),
  };
}

async function gitleaksFaults(ctx: CheckContext): Promise<Weakening[]> {
  const project = await gitleaksProject(ctx);
  if (project === undefined) return [];
  const ids = project.rules.map((rule) => rule.id);
  const redefined =
    ids.length === 0
      ? new Set<string>()
      : await defaultRuleIds(ctx, await ctx.tools.path('gitleaks'), ids);
  return [...project.faults, ...redefinitions(redefined)];
}

/** Ignore files below the root, which the tools honour for the files under them. */
function nestedIgnores(ctx: CheckContext): { readonly file: string; readonly found: Weakening }[] {
  const osv = ctx.facts
    .matching(`**/${OSV_CONFIG}`)
    .filter((file) => file !== OSV_CONFIG)
    .map((file) => ({
      file,
      found: {
        key: 'osv-scanner ignores',
        how: "keeps vulnerability exceptions outside talos.yml's supply_chain.exceptions",
      },
    }));
  const semgrep = ctx.facts
    .matching(`**/${SEMGREPIGNORE}`)
    .filter((file) => file !== SEMGREPIGNORE)
    .map((file) => ({
      file,
      found: {
        key: 'semgrep ignores',
        how: "hides files from Semgrep; talos.yml's exclude is where code is left out",
      },
    }));
  return [...osv, ...semgrep];
}

/**
 * The security tools' project-owned configuration, held to the bases: the project's gitleaks
 * file keeps every default rule and allowlists only inside its own rules, and no osv-scanner or
 * Semgrep ignore file below the root weakens what the root's generated ones say.
 */
export function strengthCheck(): Check {
  return {
    id: 'security/config-strength',
    tier: 'head',
    scope: 'repo',
    title: 'gitleaks, osv-scanner and Semgrep settings no weaker than the base',
    applies: (ctx) =>
      ctx.facts.has(GITLEAKS_PROJECT, `**/${OSV_CONFIG}`, `**/${SEMGREPIGNORE}`)
        ? APPLIES
        : skip('the repository has no project-owned security tool configuration'),
    run: async (ctx) => {
      const gitleaks = await gitleaksFaults(ctx);
      return Promise.all([
        ...gitleaks.map((found) => weaker(ctx, GITLEAKS_PROJECT, found)),
        ...nestedIgnores(ctx).map((item) => weaker(ctx, item.file, item.found)),
      ]);
    },
  };
}

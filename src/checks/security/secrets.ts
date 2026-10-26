import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GITLEAKS_PROJECT,
  type GitleaksProject,
  readGitleaksProject,
  scanConfig,
} from './gitleaks-config.js';
import { defaultRuleIds, scanHistory } from './gitleaks.js';
import { APPLIES, type Check, type CheckContext } from '../../core/check.js';

/** The project's gitleaks file, read, or nothing when the repository has none. */
export async function gitleaksProject(ctx: CheckContext): Promise<GitleaksProject | undefined> {
  if (!ctx.facts.files.includes(GITLEAKS_PROJECT)) return undefined;
  const text = await readFile(join(ctx.root, GITLEAKS_PROJECT), 'utf8');
  return readGitleaksProject(text);
}

/**
 * gitleaks over the whole history reachable from the checked-out commit, with its default
 * rules and the project's own. The gate composes the configuration itself, so nothing in the
 * project's file can switch a default rule off; the config-strength check reports what tried.
 */
export function secretsCheck(): Check {
  return {
    id: 'security/secrets',
    tier: 'head',
    scope: 'repo',
    title: 'gitleaks: no secret anywhere in the git history',
    applies: () => APPLIES,
    run: async (ctx) => {
      const tool = await ctx.tools.path('gitleaks');
      const rules = (await gitleaksProject(ctx))?.rules ?? [];
      const redefined = await defaultRuleIds(
        ctx,
        tool,
        rules.map((rule) => rule.id),
      );
      const config = join(ctx.scratch, 'gitleaks.toml');
      await writeFile(config, scanConfig(rules.filter((rule) => !redefined.has(rule.id))));
      return scanHistory(ctx, tool, config);
    },
  };
}

import { lint } from 'markdownlint-cli2/markdownlint/promise';
import { MARKDOWN_GLOBS, readText } from './files.js';
import {
  MARKDOWNLINT_CONFIG,
  MARKDOWNLINT_RULES,
  markdownlintFindings,
  NOT_LINTED,
  renderMarkdownlintBase,
} from './markdownlint.js';
import { APPLIES, type Check, skip } from '../../core/check.js';
import type { Generated } from '../../core/pack.js';
import type { RepoFacts } from '../../repo/facts.js';

/** The tracked Markdown files markdownlint reads: those the base doesn't ignore. */
function lintedFiles(facts: RepoFacts): string[] {
  const skipped = new Set(facts.matching(...NOT_LINTED));
  return facts.matching(...MARKDOWN_GLOBS).filter((file) => !skipped.has(file));
}

/** The repository's Markdown through markdownlint, with the base's rules and nothing else. */
export const markdownCheck: Check = {
  id: 'docs/markdown',
  tier: 'head',
  scope: 'repo',
  title: 'markdownlint',
  applies: (ctx) =>
    lintedFiles(ctx.facts).length > 0 ? APPLIES : skip('the repository has no Markdown to lint'),
  run: async (ctx) => {
    const strings: Record<string, string> = {};
    for (const file of lintedFiles(ctx.facts)) {
      const text = await readText(ctx, file);
      if (text !== undefined) strings[file] = text;
    }
    const results = await lint({
      strings,
      config: MARKDOWNLINT_RULES,
      noInlineConfig: true,
      handleRuleFailures: true,
    });
    return markdownlintFindings(results);
  },
};

export const markdownlintBase: Generated = {
  path: MARKDOWNLINT_CONFIG,
  scope: 'repo',
  applies: (ctx) => ctx.facts.has(...MARKDOWN_GLOBS),
  render: (ctx) => renderMarkdownlintBase(ctx.version, ctx.config.exclude),
};

import { decisionFiles, decisionTexts, MARKDOWN_GLOBS, readOwnTexts } from './files.js';
import { APPLIES, type Check, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import { judgeDecisions } from '../../docs/decisions.js';

/**
 * Decision IDs are unique across `DECISIONS.md` and the briefs, every reference in the
 * repository's Markdown resolves, and every reversal is linked both ways.
 */
export const decisionsCheck: Check = {
  id: 'docs/decisions',
  tier: 'head',
  scope: 'repo',
  title: 'decision IDs, references and reversals',
  applies: (ctx) =>
    decisionFiles(ctx).length > 0
      ? APPLIES
      : skip('the repository has no DECISIONS.md and no briefs'),
  run: async (ctx) => {
    const definitions = await decisionTexts(ctx);
    const documents = await readOwnTexts(ctx, ctx.facts.matching(...MARKDOWN_GLOBS));
    return judgeDecisions(definitions, documents).map((problem): Finding => ({
      rule: problem.rule,
      message: problem.message,
      location: {
        file: problem.file,
        line: problem.line,
        ...(problem.column === undefined ? {} : { column: problem.column }),
      },
    }));
  },
};

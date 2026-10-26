import { decisionTexts, readOwnTexts } from './files.js';
import { APPLIES, type Check, type CheckContext, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import { commentProblems, SOURCE_GLOBS } from '../../docs/comments/index.js';
import { decisionIds } from '../../docs/decisions.js';

async function comments(ctx: CheckContext): Promise<Finding[]> {
  const decisions = decisionIds(await decisionTexts(ctx));
  const sources = await readOwnTexts(ctx, ctx.facts.matching(...SOURCE_GLOBS));
  return sources.flatMap((source) =>
    commentProblems(source.file, source.text, { decisions }).map((problem): Finding => ({
      rule: problem.rule,
      message: problem.message,
      location: {
        file: source.file,
        line: problem.line,
        ...(problem.endLine === undefined ? {} : { endLine: problem.endLine }),
      },
    })),
  );
}

/**
 * Comments state invariants, outside constraints, non-obvious reasons and API docs. What can
 * be told mechanically fails: work markers, references to issues, tickets and decisions,
 * history, and commented-out code where the language's linter doesn't already find it.
 */
export const commentsCheck: Check = {
  id: 'docs/comments',
  tier: 'commit',
  scope: 'repo',
  title: 'what code comments may say',
  applies: (ctx) =>
    ctx.facts.has(...SOURCE_GLOBS) ? APPLIES : skip('the repository has no source files'),
  run: comments,
};

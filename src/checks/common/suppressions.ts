import { SUPPRESSION_GLOBS, suppressionsIn } from './suppression-scan.js';
import { ownTexts } from './texts.js';
import { APPLIES, type Check, type CheckContext, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

async function suppressions(ctx: CheckContext): Promise<Finding[]> {
  const texts = await ownTexts(ctx.root, ctx.facts.matching(...SUPPRESSION_GLOBS));
  return texts.flatMap(({ file, text }) =>
    suppressionsIn(file, text).map((hit): Finding => ({
      rule: `suppression/${hit.kind}`,
      message: hit.message,
      location: { file, line: hit.line },
    })),
  );
}

/**
 * Every suppression is a finding, so a new one fails its commit and the ones a repository
 * already had become debt.
 */
export const suppressionsCheck: Check = {
  id: 'common/suppressions',
  tier: 'commit',
  scope: 'repo',
  title: 'no suppression comments',
  applies: (ctx) =>
    ctx.facts.has(...SUPPRESSION_GLOBS)
      ? APPLIES
      : skip('the repository has no code, scripts, configs or docs'),
  run: suppressions,
};

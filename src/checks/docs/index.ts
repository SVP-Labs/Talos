import { claudeMdCheck } from './claude-md.js';
import { commentsCheck } from './comments.js';
import { decisionsCheck } from './decisions.js';
import { glossaryCheck } from './glossary.js';
import { markdownCheck, markdownlintBase } from './markdown.js';
import { referencesCheck } from './references.js';
import { cspellBase, spellingCheck } from './spelling.js';
import type { Pack } from '../../core/pack.js';

/**
 * The documentation rules: Markdown style, spelling, decision records, the glossary's avoided
 * words, links, what code comments may say, and `CLAUDE.md`.
 */
export const docsPack: Pack = {
  name: 'docs',
  checks: [
    commentsCheck,
    markdownCheck,
    spellingCheck,
    decisionsCheck,
    glossaryCheck,
    referencesCheck,
    claudeMdCheck,
  ],
  generated: [markdownlintBase, cspellBase],
};

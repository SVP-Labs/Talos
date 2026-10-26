import { decisionFiles, MARKDOWN_GLOBS, readOwnTexts, readText } from './files.js';
import { APPLIES, type Check, type CheckContext, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import { SOURCE_GLOBS } from '../../docs/comments/index.js';
import {
  type AvoidHit,
  avoidedInCode,
  avoidedWords,
  type GlossaryEntry,
  parseGlossary,
} from '../../docs/glossary.js';
import { maskCode } from '../../docs/markdown.js';

const MARKDOWN = /\.(?:md|markdown)$/;
/** A line that lists the words a glossary entry avoids, as the glossary's parser reads it. */
const AVOID_LINE = /^\s*avoid:/i;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A bold label opening a paragraph of a decision: `**Decision:**`, `**Rejected:**`. */
const LABEL = /^\*\*([^*\n:]+)(?::\*\*|\*\*:)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]/;
/** A word in double quotes, straight or curly, on one line: named, not used. */
const QUOTED = /"[^"\n]*"|“[^“”\n]*”/g;

function blank(text: string): string {
  return text.replaceAll(/[^\n]/g, ' ');
}

/** The glossary without its `Avoid:` lines, which list the words rather than use them. */
function withoutAvoidLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (AVOID_LINE.test(line) ? blank(line) : line))
    .join('\n');
}

/**
 * Whether a line still belongs to the `**Rejected:**` paragraph or list before it: a heading
 * ends it, and so does a paragraph after a blank line that is neither a list item nor indented.
 */
function continuesRejection(line: string, previous: string): boolean {
  if (HEADING.test(line)) return false;
  if (line.trim() === '' || previous.trim() !== '') return true;
  return LIST_ITEM.test(line) || /^\s/.test(line);
}

/**
 * A decision record without what it names but doesn't use: each `**Rejected:**` paragraph or
 * list, where the alternatives that lost are named by design, and words in double quotes.
 * Everything else a decision says still counts.
 */
function withoutRejections(text: string): string {
  const lines = text.split('\n');
  let rejecting = false;
  return lines
    .map((line, index) => {
      const label = LABEL.exec(line)?.[1];
      if (label !== undefined) rejecting = label.trim().toLowerCase() === 'rejected';
      else if (rejecting) rejecting = continuesRejection(line, lines[index - 1] ?? '');
      return rejecting ? blank(line) : line.replaceAll(QUOTED, blank);
    })
    .join('\n');
}

type Files = { readonly glossary: string; readonly decisions: ReadonlySet<string> };

/** The text of a file the avoided words are matched in, its line and column kept. */
function judged(file: string, text: string, files: Files): string {
  if (!MARKDOWN.test(file)) return text;
  const prose = maskCode(text);
  if (file === files.glossary) return withoutAvoidLines(prose);
  return files.decisions.has(file) ? withoutRejections(prose) : prose;
}

function hitsIn(entries: readonly GlossaryEntry[], file: string, text: string): Finding[] {
  const markdown = MARKDOWN.test(file);
  return text.split('\n').flatMap((line, index) => {
    const hits: AvoidHit[] = markdown ? avoidedWords(entries, line) : avoidedInCode(entries, line);
    return hits.map((hit) => ({
      rule: 'glossary/avoid',
      message: `"${hit.word}" is a word the glossary avoids: write "${hit.instead}" instead.`,
      location: { file, line: index + 1, column: hit.index + 1 },
    }));
  });
}

async function avoided(ctx: CheckContext): Promise<Finding[]> {
  const glossary = ctx.config.docs.glossary;
  const text = await readText(ctx, glossary);
  const entries = text === undefined ? [] : parseGlossary(text).filter((e) => e.avoid.length > 0);
  if (entries.length === 0) return [];
  const files = { glossary, decisions: new Set(decisionFiles(ctx)) };
  const docs = await readOwnTexts(ctx, ctx.facts.matching(...MARKDOWN_GLOBS, ...SOURCE_GLOBS));
  return docs.flatMap((doc) => hitsIn(entries, doc.file, judged(doc.file, doc.text, files)));
}

/**
 * The words the glossary lists under `Avoid:` fail in docs and in code, the glossary's own
 * definitions included. A decision record may name one where it rejects it, or in quotes.
 */
export const glossaryCheck: Check = {
  id: 'docs/glossary',
  tier: 'head',
  scope: 'repo',
  title: 'words the glossary avoids',
  applies: (ctx) =>
    ctx.facts.files.includes(ctx.config.docs.glossary)
      ? APPLIES
      : skip(`the repository has no glossary at ${ctx.config.docs.glossary}`),
  run: avoided,
};

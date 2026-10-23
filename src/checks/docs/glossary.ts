import { MARKDOWN_GLOBS, readOwnTexts, readText } from './files.js';
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

function hitsIn(entries: readonly GlossaryEntry[], file: string, text: string): Finding[] {
  const markdown = MARKDOWN.test(file);
  const lines = (markdown ? maskCode(text) : text).split('\n');
  return lines.flatMap((line, index) => {
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
  const files = ctx.facts
    .matching(...MARKDOWN_GLOBS, ...SOURCE_GLOBS)
    .filter((f) => f !== glossary);
  const docs = await readOwnTexts(ctx, files);
  return docs.flatMap((doc) => hitsIn(entries, doc.file, doc.text));
}

/** The words the glossary lists under `Avoid:` fail in docs and in code. */
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

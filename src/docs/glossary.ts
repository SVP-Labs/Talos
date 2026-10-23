/**
 * The glossary: one Markdown file of `**Term**` entries, each followed by its definition.
 * A line `Avoid: word, other phrase` inside an entry lists the words that term replaces; they
 * fail in code, docs and commit subjects. Every term feeds the spelling dictionary.
 */
export type GlossaryEntry = {
  readonly term: string;
  readonly line: number;
  readonly avoid: readonly string[];
};

/** The words an `Avoid:` line lists. */
function avoidList(line: string): string[] | undefined {
  if (!line.toLowerCase().startsWith('avoid:')) return undefined;
  return line
    .slice('avoid:'.length)
    .split(',')
    .map((word) => word.trim())
    .map((word) => (word.endsWith('.') ? word.slice(0, -1) : word))
    .filter(Boolean);
}

/** The bold text a line starts with: a glossary entry's term. */
function boldLead(line: string): string | undefined {
  if (!line.startsWith('**')) return undefined;
  const end = line.indexOf('**', 2);
  const term = end > 2 ? line.slice(2, end).trim() : '';
  return term === '' ? undefined : term;
}

export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: { term: string; line: number; avoid: string[] }[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const term = boldLead(line);
    if (term !== undefined) {
      entries.push({ term, line: index + 1, avoid: [] });
      continue;
    }
    const avoid = avoidList(line);
    const current = entries.at(-1);
    if (avoid !== undefined && current !== undefined) current.avoid.push(...avoid);
  }
  return entries;
}

function escape(word: string): string {
  return word.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export type AvoidHit = { readonly word: string; readonly instead: string; readonly index: number };

/** Every avoided word in `text`, matched whole and case-insensitively. */
export function avoidedWords(entries: readonly GlossaryEntry[], text: string): AvoidHit[] {
  return entries.flatMap((entry) =>
    entry.avoid.flatMap((word) => {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(word)}(?![\\p{L}\\p{N}_-])`, 'giu');
      return [...text.matchAll(pattern)].map((m) => ({
        word,
        instead: entry.term,
        index: m.index,
      }));
    }),
  );
}

/** The words of every term, for the spelling dictionary. */
export function glossaryWords(entries: readonly GlossaryEntry[]): string[] {
  const words = entries
    .flatMap((entry) => entry.term.split(/[^\p{L}\p{N}'-]+/u))
    .filter((w) => w.length > 1);
  return [...new Set(words)].sort((a, b) => a.localeCompare(b));
}

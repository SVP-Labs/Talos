import { maskCode, maskFences, maskHtmlComments } from './markdown.js';

/**
 * Decision records. A decision is a heading `## <ID> · Title` or `### <ID> · Title` in
 * `DECISIONS.md` or a brief, its ID one or two capitals and a number (`C8`, `X1`). A reversal
 * is a new entry whose first lines carry `Reverses: <old ID>`, and the old entry gains
 * `Reversed by: <new ID>`, so each links to the other.
 */
export type Decision = {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly reverses: readonly Marker[];
  readonly reversedBy: readonly Marker[];
};

type Marker = { readonly id: string; readonly line: number };

export type Reference = {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
};

export type DocText = { readonly file: string; readonly text: string };

export type DecisionProblem = {
  readonly rule:
    'decisions/duplicate-id' | 'decisions/unresolved-reference' | 'decisions/one-way-reversal';
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly message: string;
};

const HEADING = /^(#{2,3})[ \t]+([A-Z]{1,2}\d{1,4})[ \t]+[·—–:-][ \t]+\S/;
const MARKER = /^(Reversed by|Reverses)[*_]*:(.*)$/;
/** An ID-shaped token: not part of a word, a path, an anchor, a version or a ticket. */
const TOKEN = /(?<![\p{L}\p{N}_#$@/.\\-])([A-Z]{1,2})(\d{1,4})[a-z]?(?![\p{L}\p{N}_-]|\.\d)/gu;
/** What joins the IDs of one citation: `C3, C15 and C20`, `I1 to I7`. */
const JOINER = /^(?:,(?: and| or)?|and|or|to|[;/–&-])$/;

/** The IDs a marker line names. */
function idsIn(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((match) => `${match[1] ?? ''}${match[2] ?? ''}`);
}

function markersIn(lines: readonly string[], from: number, to: number): Marker[][] {
  const reverses: Marker[] = [];
  const reversedBy: Marker[] = [];
  for (let index = from; index < to; index += 1) {
    const match = MARKER.exec((lines[index] ?? '').replace(/^[>*_\s]+/, ''));
    if (match === null) continue;
    const into = match[1] === 'Reverses' ? reverses : reversedBy;
    into.push(...idsIn(match[2] ?? '').map((id) => ({ id, line: index + 1 })));
  }
  return [reverses, reversedBy];
}

/** The decisions a document defines, each with its reversal markers. */
export function decisionsIn(doc: DocText): Decision[] {
  const lines = maskHtmlComments(maskFences(doc.text)).split('\n');
  const starts = lines.flatMap((line, index) => {
    const match = HEADING.exec(line);
    return match?.[2] === undefined ? [] : [{ id: match[2], index }];
  });
  const headingLines = lines.flatMap((line, index) => (/^#{1,3}\s/.test(line) ? [index] : []));
  return starts.map(({ id, index }) => {
    const end = headingLines.find((line) => line > index) ?? lines.length;
    const [reverses = [], reversedBy = []] = markersIn(lines, index + 1, end);
    return { id, file: doc.file, line: index + 1, reverses, reversedBy };
  });
}

function prefixOf(id: string): string {
  return /^[A-Z]+/.exec(id)?.[0] ?? '';
}

/** The systems whose decisions SVP-Labs documents cite by name: `Talos C20`, `Thea D8`. */
const SYSTEMS = new Set(['Talos', 'Thea']);

/**
 * Whether the words before a citation name another repository's or person's decisions: a
 * possessive or a pronoun (`Thea's D8`, `her G1`), a system's name, or a capitalised word in
 * the middle of a sentence (`the LoreLock D3 rule`).
 */
function qualified(before: string): boolean {
  const trimmed = before.trimEnd();
  if (trimmed === before) return false;
  const start =
    Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\t'), trimmed.lastIndexOf('(')) + 1;
  const word = trimmed.slice(start).replaceAll(/[*_]/g, '');
  if (/['’]s$/.test(word) || /^(?:her|his|its|their)$/i.test(word) || SYSTEMS.has(word)) {
    return true;
  }
  if (!/^[A-Z]\p{L}+$/u.test(word)) return false;
  const rest = trimmed.slice(0, start).replaceAll(/[*_]/g, '').trimEnd();
  return rest !== '' && !/(?:[.:!?|>]|^\s*(?:[-+]|\d+[.)]))$/.test(rest);
}

type Token = { readonly id: string; readonly start: number; readonly end: number };

/** Groups tokens into citations: tokens joined only by commas, `and`, `to` and the like. */
function citations(line: string): Token[][] {
  const groups: Token[][] = [];
  for (const match of line.matchAll(TOKEN)) {
    const token = {
      id: `${match[1] ?? ''}${match[2] ?? ''}`,
      start: match.index,
      end: match.index + match[0].length,
    };
    const last = groups.at(-1)?.at(-1);
    const between = line
      .slice(last?.end ?? 0, token.start)
      .trim()
      .replaceAll(/\s+/g, ' ');
    if (last !== undefined && JOINER.test(between)) {
      groups.at(-1)?.push(token);
    } else groups.push([token]);
  }
  return groups;
}

/**
 * The references a document makes to this repository's decisions: ID tokens in prose whose
 * prefix is one the repository defines. A citation qualified by a name (`Talos C20`, `Thea's
 * D8`, `her G1`) points at another repository's decisions and is left alone.
 */
export function referencesIn(doc: DocText, prefixes: ReadonlySet<string>): Reference[] {
  const lines = maskCode(doc.text).split('\n');
  return lines.flatMap((line, index) =>
    citations(line)
      .filter((group) => !qualified(line.slice(0, group[0]?.start ?? 0)))
      .flat()
      .filter((token) => prefixes.has(prefixOf(token.id)))
      .map((token) => ({ id: token.id, file: doc.file, line: index + 1, column: token.start + 1 })),
  );
}

function duplicates(decisions: readonly Decision[]): DecisionProblem[] {
  const first = new Map<string, Decision>();
  return decisions.flatMap((decision): DecisionProblem[] => {
    const earlier = first.get(decision.id);
    if (earlier === undefined) {
      first.set(decision.id, decision);
      return [];
    }
    return [
      {
        rule: 'decisions/duplicate-id',
        file: decision.file,
        line: decision.line,
        message:
          `${decision.id} is already defined at ${earlier.file}:${String(earlier.line)}; ` +
          'give this decision an ID of its own.',
      },
    ];
  });
}

function oneWay(byId: ReadonlyMap<string, Decision>, decision: Decision): DecisionProblem[] {
  const check = (marker: Marker, back: 'reverses' | 'reversedBy'): DecisionProblem[] => {
    const other = byId.get(marker.id);
    if (other === undefined || other[back].some((m) => m.id === decision.id)) return [];
    const [said, missing] =
      back === 'reversedBy' ? ['reverses', 'Reversed by'] : ['is reversed by', 'Reverses'];
    return [
      {
        rule: 'decisions/one-way-reversal',
        file: decision.file,
        line: marker.line,
        message:
          `${decision.id} ${said} ${marker.id}, but ${marker.id} has no ` +
          `"${missing}: ${decision.id}" line; link the two both ways.`,
      },
    ];
  };
  return [
    ...decision.reverses.flatMap((marker) => check(marker, 'reversedBy')),
    ...decision.reversedBy.flatMap((marker) => check(marker, 'reverses')),
  ];
}

/**
 * Judges the decision records: `definitions` are `DECISIONS.md` and the briefs, `documents`
 * every Markdown file whose references must resolve (the definitions among them).
 */
export function judgeDecisions(
  definitions: readonly DocText[],
  documents: readonly DocText[],
): DecisionProblem[] {
  const decisions = definitions.flatMap((doc) => decisionsIn(doc));
  const byId = new Map<string, Decision>();
  for (const decision of decisions) if (!byId.has(decision.id)) byId.set(decision.id, decision);
  const prefixes = new Set(decisions.map((decision) => prefixOf(decision.id)));
  const unresolved = documents
    .flatMap((doc) => referencesIn(doc, prefixes))
    .filter((reference) => !byId.has(reference.id))
    .map((reference): DecisionProblem => ({
      rule: 'decisions/unresolved-reference',
      file: reference.file,
      line: reference.line,
      column: reference.column,
      message: `${reference.id} names no decision in DECISIONS.md or the briefs.`,
    }));
  return [
    ...duplicates(decisions),
    ...unresolved,
    ...decisions.flatMap((decision) => oneWay(byId, decision)),
  ];
}

/** Every decision ID the documents define, for checks that look for citations elsewhere. */
export function decisionIds(definitions: readonly DocText[]): Set<string> {
  return new Set(definitions.flatMap((doc) => decisionsIn(doc).map((decision) => decision.id)));
}

import type { CommentLine } from './scan.js';

type CommentRule = 'comments/todo' | 'comments/reference' | 'comments/history' | 'comments/code';

export type CommentProblem = {
  readonly rule: CommentRule;
  readonly line: number;
  readonly endLine?: number;
  readonly message: string;
};

/** What the reference rule needs from the repository. */
export type CommentContext = {
  /** Every decision ID `DECISIONS.md` and the briefs define. */
  readonly decisions: ReadonlySet<string>;
};

/** Languages whose linters don't already find commented-out code. */
export type CodeShape = 'rust' | 'php' | 'lua' | 'shell' | 'powershell';

function blank(text: string): string {
  return ' '.repeat(text.length);
}

/** URLs and quoted code are what a comment shows, not what it says. */
function prose(text: string): string {
  return text
    .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank)
    .replaceAll(/`[^`]*`/g, blank)
    .replaceAll(/\b[\w.-]+\/[\w.-]+#\d+\b/g, blank);
}

const TODO = /\b(todo|fixme|xxx|hack)\b(\s*[:(])?/gi;

/** A work marker: one written in capitals, or any spelling followed by `:` or `(`. */
function todo(text: string): string | undefined {
  for (const match of text.matchAll(TODO)) {
    const word = match[1] ?? '';
    if (word === word.toUpperCase() || match[2] !== undefined) return word.toUpperCase();
  }
  return undefined;
}

/** Ticket-shaped tokens that are standards and formats, not tickets. */
const NOT_TICKETS = new Set(
  [
    'AES ANSI ARM ASN AVX BS COVID CP CRC CVE CWE DIN ECMA EN ES FIPS GPT GHSA HTTP IEC',
    'IEEE ISO KOI MD NIST P PEP PSR RFC RSA SHA SP SSL TLS UCS UTF WCAG X',
  ]
    .join(' ')
    .split(' '),
);
const TICKET = /(?<![\p{L}\p{N}_/.-])([A-Z][A-Z0-9]{0,9})-(\d+)(?![\p{L}\p{N}_-]|\.\d)/gu;
const ISSUE = /(?<![\p{L}\p{N}_&$#{/])#([1-9]\d*)\b/gu;

function tickets(text: string): string[] {
  const found = [...text.matchAll(TICKET)]
    .filter((match) => !NOT_TICKETS.has(match[1] ?? ''))
    .map((match) => match[0]);
  return [...found, ...[...text.matchAll(ISSUE)].map((match) => match[0])];
}

const ID = String.raw`[A-Z]{1,2}\d{1,3}[a-z]?`;
const TOKEN = /(?<![\p{L}\p{N}_#$@/.\\-])([A-Z]{1,2}\d{1,3})[a-z]?(?![\p{L}\p{N}_-]|\.\d)/gu;
const CITATION = new RegExp(
  String.raw`^(?:(?:her|his|its|their|see|per|cf\.?|also|[A-Z][\w'’]*)\s+)?${ID}` +
    String.raw`(?:\s*(?:,|and|or|to|–|-|/|&)\s*${ID})*$`,
  'u',
);
/** Bare tokens that are names of things far more often than decisions. */
const COMMON = new Set([
  ...'H1 H2 H3 H4 H5 H6 V8 S3 R2 M1 M2 M3 M4 X11 L1 L2 L3'.split(' '),
  ...Array.from({ length: 12 }, (_, index) => `F${String(index + 1)}`),
]);

/** A short ID cited in parentheses, or any ID this repository defines. */
function cited(id: string, decisions: ReadonlySet<string>): boolean {
  return decisions.has(id) || /^[A-Z]\d{1,2}$/.test(id);
}

type Cited = { readonly id: string; readonly offset: number };

/** The ID tokens of parenthesised citations, such as `(K4, K5)` or `(Talos C20)`. */
function citationTokens(text: string): Cited[] {
  const tokens: Cited[] = [];
  for (const group of text.matchAll(/\(([^()]*)\)/g)) {
    let offset = group.index + 1;
    for (const part of (group[1] ?? '').split(/([,;])/)) {
      const tokensOfPart = CITATION.test(part.trim()) ? [...part.matchAll(TOKEN)] : [];
      tokens.push(
        ...tokensOfPart.map((token) => ({ id: token[1] ?? '', offset: offset + token.index })),
      );
      offset += part.length;
    }
  }
  return tokens;
}

function decisionRefs(text: string, ctx: CommentContext): string[] {
  const citations = citationTokens(text);
  const inCitations = new Set(citations.map((token) => token.offset));
  const found = citations.filter((token) => cited(token.id, ctx.decisions)).map((t) => t.id);
  for (const token of text.matchAll(TOKEN)) {
    const id = token[1] ?? '';
    if (!inCitations.has(token.index) && ctx.decisions.has(id) && !COMMON.has(id)) found.push(id);
  }
  return found;
}

const DATE = String.raw`(?:\d{4}-\d{2}(?:-\d{2})?\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)`;
const CHANGED = String.raw`\b(?:added|changed|amended|modified|introduced|removed|updated|fixed|deprecated|re-?decided)`;

const HISTORY = [
  new RegExp(String.raw`${CHANGED}\s+(?:(?:on|in)\s+(?:v?\d+\.\d+\b|${DATE})|${DATE})`, 'i'),
  /^(?:added|changed|modified|introduced|written)\s+by\b/i,
  /\b(?:was|were)\s+previously\b|\bpreviously\s+(?:was|were|it|this|we|returned|called)\b/i,
  /\bused\s+to\s+be\b|\bformerly\b|\brenamed\s+from\b|\bwas\s+(?:added|changed|renamed)\s+(?:in|on|by)\b/i,
  /\b(?:originally|initially)\s+(?:was|were|this|it|we)\b/i,
];

const CODE: Readonly<Record<CodeShape, readonly RegExp[]>> = {
  rust: [
    /^(?:let|fn|use|pub|impl|mod|struct|enum|match|if|for|while|loop)\b.*[;{]$/,
    /^[\w:.]+!?\(.*\)\s*;$/,
    /^\w[\w.]* ?= ?[^\s=].*;$/,
    /^[{}]$/,
  ],
  php: [
    /^\$\w.*;$/,
    /^(?:echo|return|use|namespace|require|include|throw|new)\b.*;$/,
    /^(?:if|foreach|for|while|function|switch)\b.*\{$/,
    /^[\w\\]+(?:->|::)\w+\(.*\)\s*;$/,
    /^[{}]$/,
  ],
  lua: [
    /^local [^=]+=[^=]/,
    /^[\w.:]+\(.*\)$/,
    /^(?:if|while|for)\b.*\b(?:then|do)$/,
    /^[\w.[\]"']+\s*=\s*\S.*$/,
  ],
  shell: [
    /^[A-Za-z_]\w*=\S*$/,
    /^(?:export|local|readonly)\s+\w+=/,
    /^(?:if|while)\s+\[.*\];?\s*(?:then|do)?$/,
    /^(?:fi|done|esac)$/,
    /^(?:echo|printf)\s+["'$]/,
  ],
  powershell: [
    /^\$[\w:]+\s*=/,
    /^[A-Z][a-z]+-[A-Z]\w*(?:\s|$)/,
    /^(?:if|foreach|while)\s*\(.*\)\s*\{?$/,
    /^[{}]$/,
  ],
};

function lineProblems(comment: CommentLine, ctx: CommentContext): CommentProblem[] {
  const text = prose(comment.text);
  const problems: CommentProblem[] = [];
  const at = { line: comment.line };
  const marker = todo(text);
  if (marker !== undefined) {
    problems.push({
      rule: 'comments/todo',
      ...at,
      message: `This comment carries a ${marker} marker; file an issue for the work instead.`,
    });
  }
  const references = [...tickets(text), ...decisionRefs(text, ctx)];
  if (references.length > 0) {
    problems.push({
      rule: 'comments/reference',
      ...at,
      message:
        `This comment cites ${[...new Set(references)].join(', ')}; ` +
        'say the reason itself, not where it was decided or tracked.',
    });
  }
  if (HISTORY.some((pattern) => pattern.test(text.trim()))) {
    problems.push({
      rule: 'comments/history',
      ...at,
      message:
        "This comment tells the code's history; say what holds now, and leave history to the PR.",
    });
  }
  return problems;
}

/** Runs of consecutive line comments that read as code, each one problem. */
function commentedCode(lines: readonly CommentLine[], shape: CodeShape): CommentProblem[] {
  const runs: { line: number; endLine: number }[] = [];
  for (const comment of lines) {
    if (comment.doc || comment.block) continue;
    if (!CODE[shape].some((pattern) => pattern.test(comment.text))) continue;
    const last = runs.at(-1);
    if (last?.endLine === comment.line - 1) last.endLine = comment.line;
    else runs.push({ line: comment.line, endLine: comment.line });
  }
  return runs.map((run) => ({
    rule: 'comments/code',
    line: run.line,
    ...(run.endLine > run.line ? { endLine: run.endLine } : {}),
    message: 'This comment holds code; delete it, since git keeps what was there.',
  }));
}

/** What the comment rules find in one file's comments. */
export function judgeComments(
  lines: readonly CommentLine[],
  ctx: CommentContext,
  shape?: CodeShape,
): CommentProblem[] {
  return [
    ...lines.flatMap((comment) => lineProblems(comment, ctx)),
    ...(shape === undefined ? [] : commentedCode(lines, shape)),
  ];
}

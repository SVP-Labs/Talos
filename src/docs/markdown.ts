/**
 * Small, line-preserving Markdown helpers for the docs checks: they hide what isn't prose (code,
 * HTML comments) without moving any character, so a match's line and column stay true.
 */

const FENCE = /^\s*(`{3,}|~{3,})/;

function blank(text: string): string {
  return text.replaceAll(/[^\n]/g, ' ');
}

/** Blanks fenced code blocks, fences included. An unclosed fence runs to the end. */
export function maskFences(text: string): string {
  const lines = text.split('\n');
  let open: string | undefined;
  return lines
    .map((line) => {
      const fence = FENCE.exec(line)?.[1];
      if (open === undefined) {
        if (fence === undefined) return line;
        open = fence;
        return blank(line);
      }
      const closes =
        fence?.startsWith(open[0] ?? '') === true &&
        fence.length >= open.length &&
        line.trim() === fence;
      if (closes) open = undefined;
      return blank(line);
    })
    .join('\n');
}

/** Blanks HTML comments, which a reader never sees. */
export function maskHtmlComments(text: string): string {
  return text.replaceAll(/<!--[\s\S]*?(?:-->|$)/g, (comment) => blank(comment));
}

/** The end of a code span opened by `ticks` at `from`, before the paragraph ends. */
function spanEnd(text: string, from: number, ticks: number): number | undefined {
  const pattern = /`+|\n[ \t]*\n/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0].startsWith('\n')) return undefined;
    if (match[0].length === ticks) return match.index + ticks;
  }
  return undefined;
}

/** Blanks inline code spans; a backtick run with no closing run stays as text. */
export function maskCodeSpans(text: string): string {
  let out = '';
  let index = 0;
  const opener = /`+/g;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    if (match.index < index) continue;
    const end = spanEnd(text, match.index + match[0].length, match[0].length);
    if (end === undefined) continue;
    out += text.slice(index, match.index) + blank(text.slice(match.index, end));
    index = end;
    opener.lastIndex = end;
  }
  return out + text.slice(index);
}

/** Only the prose: code blocks, code spans and HTML comments blanked. */
export function maskCode(text: string): string {
  return maskCodeSpans(maskHtmlComments(maskFences(text)));
}

export type Heading = {
  readonly level: number;
  /** The heading's raw Markdown text, without its `#` marks. */
  readonly text: string;
  /** 1-based. */
  readonly line: number;
};

const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** An ATX heading's level and text, its closing `#`s dropped; undefined for any other line. */
function atx(line: string): { level: number; text: string } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line);
  if (match === null) return undefined;
  const text = line.slice(match[0].length).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  const closed = end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t';
  return { level: match[1]?.length ?? 1, text: closed ? text.slice(0, end).trim() : text };
}

function underlinedLevel(previous: string, line: string): number | undefined {
  const underline = UNDERLINE.exec(line)?.[1];
  if (underline === undefined) return undefined;
  const text = previous.trim();
  if (text === '' || atx(previous) !== undefined || /^([-*+]|\d+[.)])\s|^[|>]/.test(text)) {
    return undefined;
  }
  return underline.startsWith('=') ? 1 : 2;
}

/** ATX and underlined headings outside code blocks, in order. */
export function headings(text: string): Heading[] {
  const original = text.split('\n');
  const masked = maskHtmlComments(maskFences(text)).split('\n');
  const found: Heading[] = [];
  for (const [index, line] of masked.entries()) {
    const heading = atx(line);
    if (heading !== undefined) {
      const raw = atx(original[index] ?? '')?.text ?? heading.text;
      found.push({ level: heading.level, text: raw, line: index + 1 });
      continue;
    }
    const level = index > 0 ? underlinedLevel(masked[index - 1] ?? '', line) : undefined;
    if (level !== undefined) {
      found.push({ level, text: (original[index - 1] ?? '').trim(), line: index });
    }
  }
  return found;
}

/**
 * Cuts each span from `start` to the next `end` out of the text; `opens` says whether a start
 * marker really opens one, such as a `<` that begins a tag.
 */
function cut(
  text: string,
  [start, end]: readonly [string, string],
  opens: (after: string) => boolean = () => true,
): string {
  let out = '';
  let index = 0;
  for (let open = text.indexOf(start); open !== -1; open = text.indexOf(start, open + 1)) {
    const close = text.indexOf(end, open + start.length);
    if (open < index || close === -1 || !opens(text.charAt(open + start.length))) continue;
    out += text.slice(index, open);
    index = close + end.length;
  }
  return out + text.slice(index);
}

/**
 * What a heading renders as, near enough for its anchor: links' destinations, HTML tags,
 * backticks and emphasis dropped. A link's opening bracket stays; the anchor drops it.
 */
export function headingText(raw: string): string {
  const withoutLinks = cut(cut(raw, ['](', ')']), ['][', ']']);
  return cut(withoutLinks, ['<', '>'], (after) => /[a-z/!]/i.test(after))
    .replaceAll('`', '')
    .replaceAll(/\\([!-/:-@[-`{-~])/g, '$1')
    .replaceAll(/(?<=[\p{L}\p{N}])[*_]+(?=[^\p{L}\p{N}*_]|$)|(^|[^\p{L}\p{N}])[*_]+/gu, '$1')
    .trim();
}

/**
 * GitHub's anchors for a document's headings: lower case, everything but letters, digits,
 * marks, connector punctuation, spaces and hyphens dropped, spaces turned into hyphens, and a
 * repeated anchor numbered `-1`, `-2` and on.
 */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = headingText(text)
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replaceAll(' ', '-');
    let slug = base;
    while (seen.has(slug)) {
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      slug = `${base}-${count}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

/** Every anchor a document offers: its headings' and any explicit `id` or `name`. */
export function anchors(text: string): Set<string> {
  const slug = slugger();
  const found = new Set(headings(text).map((heading) => slug(heading.text)));
  for (const match of maskFences(text).matchAll(/<[a-z][^>]*\s(?:id|name)=["']([^"']+)["']/gi)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return found;
}

/** 1-based line and column of an offset. */
export function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, column: offset - lineStart + 1 };
}

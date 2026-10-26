/**
 * An issue body's `##` sections, as the issue forms write them (`### Goal`) or a person types
 * them. Headings are matched without case, trailing colons or spacing around a slash, so
 * "Expected / Actual" and "expected/actual:" are the same section.
 */

const HEADING = /^#{2,6}[ \t]+(\S.*)$/;
const CHECKBOX = /^[ \t]*[-*+] \[[ xX]\] \S/;
const NO_RESPONSE = '_No response_';

export function sectionKey(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/:$/, '')
    .split('/')
    .map((part) => part.trim().replaceAll(/\s+/g, ' '))
    .join('/');
}

/** Each section's text by its key; the first of two sections with one key wins. */
export function sections(body: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  let key: string | undefined;
  let lines: string[] = [];
  const close = (): void => {
    if (key !== undefined && !found.has(key)) found.set(key, lines.join('\n').trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING.exec(line)?.[1];
    if (heading === undefined) {
      lines.push(line);
      continue;
    }
    close();
    key = sectionKey(heading);
    lines = [];
  }
  close();
  return found;
}

/** Whether a section says something: issue forms write `_No response_` for an empty field. */
export function hasContent(text: string | undefined): boolean {
  if (text === undefined) return false;
  const trimmed = text.trim();
  return trimmed !== '' && trimmed !== NO_RESPONSE;
}

export function checkboxCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => CHECKBOX.test(line)).length;
}

const LISTED_PATH = /^[ \t]*[-*+][ \t]+`([^`\s]+)`[ \t]*$/;

/**
 * The paths an `Affected areas` section lists, one per item as `` - `path` ``: the form Talos
 * writes for its own debt issues and sync chores, which the review reads to decide whether a
 * diff stays inside its issue. Items in other words name no path.
 */
export function affectedPaths(body: string): string[] {
  const text = sections(body).get('affected areas') ?? '';
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const path = LISTED_PATH.exec(line)?.[1];
    if (path !== undefined && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

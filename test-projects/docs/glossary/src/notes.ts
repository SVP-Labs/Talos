/** The title of a page of text. */
export function memoTitle(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

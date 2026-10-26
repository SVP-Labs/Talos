/** Collapses whitespace and cuts the text to `max` characters, marking a cut with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The first line of a tool's message that says something, clipped. */
export function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? '';
  return clip(line, max);
}

/** The last lines of a tool's output, each clipped, for an engine error's message. */
export function lastLines(text: string, count = 20, width = 200): string {
  return text
    .trimEnd()
    .split(/\r?\n/)
    .slice(-count)
    .map((line) => (line.length <= width ? line : `${line.slice(0, width - 1)}…`))
    .join('\n');
}

/** Line numbers as compact ranges: `3-5,9`. */
export function lineRanges(lines: readonly number[]): string {
  const ranges: [number, number][] = [];
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last !== undefined && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges.map(([first, end]) => (first === end ? `${first}` : `${first}-${end}`)).join(',');
}

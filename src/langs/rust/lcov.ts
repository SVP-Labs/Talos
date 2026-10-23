type FileRecord = { readonly file: string; readonly lines: string[] };

function records(text: string): FileRecord[] {
  const found: FileRecord[] = [];
  let current: FileRecord | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = { file: line.slice(3), lines: [] };
      found.push(current);
    } else if (line === 'end_of_record') current = undefined;
    else if (current !== undefined && line !== '') current.lines.push(line);
  }
  return found;
}

function lineOf(entry: string): number {
  return Number.parseInt(entry.slice(entry.indexOf(':') + 1), 10);
}

/** A `DA:<line>,<hits>` or `BRDA:<line>,<block>,<branch>,<taken>` entry that ran. */
function hit(entry: string): boolean {
  const count = entry.split(',').at(-1) ?? '0';
  return count !== '0' && count !== '-';
}

function rewrite(
  lines: readonly string[],
  file: string,
  isTestLine: (line: number) => boolean,
): string[] {
  const kept = lines.filter((entry) => !/^(DA|BRDA):/.test(entry) || !isTestLine(lineOf(entry)));
  const da = kept.filter((entry) => entry.startsWith('DA:'));
  const brda = kept.filter((entry) => entry.startsWith('BRDA:'));
  const counts = new Map([
    ['LF', da.length],
    ['LH', da.filter(hit).length],
    ['BRF', brda.length],
    ['BRH', brda.filter(hit).length],
  ]);
  const body = kept.map((entry) => {
    const key = entry.slice(0, entry.indexOf(':'));
    const count = counts.get(key);
    return count === undefined ? entry : `${key}:${String(count)}`;
  });
  return [`SF:${file}`, ...body, 'end_of_record'];
}

/**
 * cargo-llvm-cov's LCOV with each file's path made relative to the component (`place` returns
 * undefined for a file to leave out: outside the component, a test, generated) and the lines of
 * its test items dropped, since tests are not the code coverage measures.
 */
export function rewriteLcov(
  text: string,
  place: (file: string) => string | undefined,
  testLines: (file: string) => (line: number) => boolean,
): string {
  const out = records(text).flatMap((record) => {
    const file = place(record.file);
    return file === undefined ? [] : rewrite(record.lines, file, testLines(file));
  });
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

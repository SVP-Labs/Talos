import type { FileSpans } from './spans.js';
import type { Finding } from '../../core/finding.js';

export const MAX_FILE_LINES = 400;
const MAX_FUNCTION_LINES = 60;

/**
 * Which lines count towards a size limit, by 1-based line number: blank lines, comments and
 * docstrings don't, as ESLint's limits skip blank lines and comments.
 */
export function countedLines(text: string, docstrings: FileSpans['docstrings']): boolean[] {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  const counted = lines.map((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
  for (const [start, end] of docstrings) {
    for (let line = start; line <= end; line += 1) counted[line - 1] = false;
  }
  return [false, ...counted];
}

function countBetween(counted: readonly boolean[], start: number, end: number): number {
  let total = 0;
  for (let line = start; line <= end; line += 1) if (counted[line] === true) total += 1;
  return total;
}

function nthCounted(counted: readonly boolean[], n: number): number {
  let seen = 0;
  for (let line = 1; line < counted.length; line += 1) {
    if (counted[line] === true) seen += 1;
    if (seen === n) return line;
  }
  return counted.length - 1;
}

/**
 * The file and function size limits ruff has no rule for. `file` is repository-relative; test
 * code is exempt, as it is from ESLint's limits.
 */
export function sizeFindings(file: string, text: string, spans: FileSpans): Finding[] {
  const counted = countedLines(text, spans.docstrings);
  const last = counted.length - 1;
  const findings: Finding[] = [];
  const total = countBetween(counted, 1, last);
  if (total > MAX_FILE_LINES) {
    findings.push({
      rule: 'talos/max-lines',
      message: `This file has ${total} lines of code; the most allowed is ${MAX_FILE_LINES}.`,
      location: { file, line: nthCounted(counted, MAX_FILE_LINES + 1), endLine: last },
    });
  }
  for (const fn of spans.functions) {
    const lines = countBetween(counted, fn.start, fn.end);
    if (lines <= MAX_FUNCTION_LINES) continue;
    findings.push({
      rule: 'talos/max-lines-per-function',
      message:
        `Function '${fn.name}' has ${lines} lines of code; ` +
        `the most allowed is ${MAX_FUNCTION_LINES}.`,
      location: { file, line: fn.start, endLine: fn.end },
    });
  }
  return findings;
}

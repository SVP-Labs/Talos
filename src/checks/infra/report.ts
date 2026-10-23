import { EngineError } from '../../core/check.js';
import type { ExecResult } from '../../exec/exec.js';

const BOM = String.fromCodePoint(0xfeff);

function trimTrailing(text: string, characters: string): string {
  let end = text.length;
  while (end > 0 && characters.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** Where a line's first sentence ends: a stop before a space, not the end of an ellipsis. */
function firstStop(line: string): number {
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line.charAt(index);
    const ellipsis = char === '.' && line.charAt(index - 1) === '.';
    if ('.!?'.includes(char) && /\s/.test(line.charAt(index + 1)) && !ellipsis) return index;
  }
  return -1;
}

/** A tool's message as one sentence: its first, capitalised, ending with a full stop. */
export function sentence(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').trim();
  const end = firstStop(line);
  const first = trimTrailing(end === -1 ? line : line.slice(0, end + 1), ' \t:;,');
  const capital = first.charAt(0).toUpperCase() + first.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** Text a tool printed as JSON; anything else is an engine error. */
export function parseJson(text: string, what: string): unknown {
  try {
    const value: unknown = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    return value;
  } catch {
    const shown = text.trim().slice(0, 200);
    const detail = shown === '' ? '' : `: ${shown}`;
    throw new EngineError(`${what} printed no readable JSON${detail}`);
  }
}

/** An engine error for a tool that failed, ending with the last of what it printed. */
export function toolFailed(what: string, result: ExecResult): EngineError {
  const printed = result.stderr.trim() === '' ? result.stdout : result.stderr;
  const last = printed.trim().split('\n').slice(-10).join('\n');
  const detail = last === '' ? '' : `:\n${last}`;
  return new EngineError(`${what} exited ${result.code}${detail}`);
}

/** A value NEON can hold: what PHPStan's configs are made of. */
type NeonValue = NeonScalar | NeonList | NeonMap;
type NeonScalar = string | number | boolean | null;
type NeonList = readonly NeonValue[];
export type NeonMap = { readonly [key: string]: NeonValue };

const INDENT = '    ';

/** NEON reads JSON's double-quoted strings, escapes included, so every string is quoted. */
function scalar(value: NeonScalar): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return value === null ? 'null' : String(value);
}

function key(name: string): string {
  return /^[A-Za-z_][\w.-]*!?$/.test(name) ? name : JSON.stringify(name);
}

function isList(value: NeonValue): value is NeonList {
  return Array.isArray(value);
}

function isScalar(value: NeonValue): value is NeonScalar {
  return value === null || typeof value !== 'object';
}

/** The value written on its key's own line, or undefined when it needs a block of its own. */
function inline(value: NeonValue): string | undefined {
  if (isScalar(value)) return scalar(value);
  if (isList(value)) return value.length === 0 ? '[]' : undefined;
  return Object.keys(value).length === 0 ? '{}' : undefined;
}

function entry(head: string, value: NeonValue, depth: number): string[] {
  const short = inline(value);
  if (short !== undefined) return [`${head} ${short}`];
  return isScalar(value) ? [] : [head, ...lines(value, depth + 1)];
}

function lines(value: NeonList | NeonMap, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  if (isList(value)) return value.flatMap((item) => entry(`${pad}-`, item, depth));
  return Object.entries(value).flatMap(([name, item]) => entry(`${pad}${key(name)}:`, item, depth));
}

/** A mapping written as block-style NEON, four spaces per level. */
export function toNeon(value: NeonMap): string {
  return `${lines(value, 0).join('\n')}\n`;
}

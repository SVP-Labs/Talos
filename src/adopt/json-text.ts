/**
 * JSON laid out as Prettier lays out a file it formats from scratch, so a project's formatter
 * leaves the files adoption writes alone: objects one key a line, a list of plain values on one
 * line when it fits in 100 columns, else one item a line.
 */

const WIDTH = 100;

const plain = (value: unknown): boolean => value === null || typeof value !== 'object';

function list(items: readonly unknown[], indent: string, used: number): string {
  if (items.length === 0) return '[]';
  if (items.every(plain)) {
    const inline = `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
    if (used + inline.length <= WIDTH) return inline;
  }
  const inner = `${indent}  `;
  const lines = items.map((item, index) => {
    const comma = index < items.length - 1 ? 1 : 0;
    return `${inner}${render(item, inner, inner.length + comma)}`;
  });
  return `[\n${lines.join(',\n')}\n${indent}]`;
}

function render(value: unknown, indent: string, used: number): string {
  if (Array.isArray(value)) return list(value, indent, used);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.keys(value).map((key): [string, unknown] => [
    key,
    Reflect.get(value, key),
  ]);
  if (entries.length === 0) return '{}';
  const inner = `${indent}  `;
  const lines = entries.map(([key, item], index) => {
    const head = `${inner}${JSON.stringify(key)}: `;
    const comma = index < entries.length - 1 ? 1 : 0;
    return `${head}${render(item, inner, head.length + comma)}`;
  });
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

export function prettyJson(value: unknown): string {
  return `${render(value, '', 0)}\n`;
}

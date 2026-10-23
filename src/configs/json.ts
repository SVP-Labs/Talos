/** A value of a flat JSON config: a scalar or a list of strings. */
export type FlatValue = string | number | boolean | readonly string[];

/** Prettier's line width for every governed repository. */
const WIDTH = 100;

function stringArray(prefix: string, items: readonly string[], comma: string): string {
  const inline = `${prefix}[${items.map((item) => JSON.stringify(item)).join(', ')}]${comma}`;
  if (items.length === 0 || inline.length <= WIDTH) return inline;
  const lines = items.map(
    (item, index) => `    ${JSON.stringify(item)}${index === items.length - 1 ? '' : ','}`,
  );
  return `${prefix}[\n${lines.join('\n')}\n  ]${comma}`;
}

function property(key: string, value: FlatValue, last: boolean): string {
  const prefix = `  ${JSON.stringify(key)}: `;
  const comma = last ? '' : ',';
  if (typeof value === 'object') return stringArray(prefix, value, comma);
  return `${prefix}${JSON.stringify(value)}${comma}`;
}

/**
 * A flat JSON object as Prettier writes it, so a project's formatter leaves the generated file
 * alone: one key a line, and a list on one line when it fits, else one item a line.
 */
export function renderFlatJson(entries: Readonly<Record<string, FlatValue>>): string {
  const pairs = Object.entries(entries);
  const body = pairs.map(([key, value], index) => property(key, value, index === pairs.length - 1));
  return `{\n${body.join('\n')}\n}\n`;
}

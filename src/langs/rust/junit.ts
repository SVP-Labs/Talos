/** JUnit text helpers: the runners' reports gain a `file` attribute per test case. */

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function unescapeXml(text: string): string {
  return text.replaceAll(/&(amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(String.raw`\s${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : unescapeXml(match[1]);
}

/**
 * cargo-nextest's JUnit with a `file` attribute on every test case it can place: nextest names
 * a case's binary in `classname` and its module path in `name`, but not its file.
 */
export function withFiles(
  xml: string,
  fileOf: (test: { readonly binary: string; readonly name: string }) => string | undefined,
): string {
  return xml.replaceAll(/<testcase\b[^>]*>/g, (tag) => {
    if (attribute(tag, 'file') !== undefined) return tag;
    const binary = attribute(tag, 'classname');
    const name = attribute(tag, 'name');
    const file = binary === undefined || name === undefined ? undefined : fileOf({ binary, name });
    return file === undefined
      ? tag
      : tag.replace('<testcase', `<testcase file="${escapeXml(file)}"`);
  });
}

export type Case = {
  readonly name: string;
  readonly classname: string;
  readonly file: string;
  /** Present when the case failed. */
  readonly failure?: string;
  readonly skipped?: boolean;
};

/** A JUnit report of the given cases, as one suite. */
export function junitXml(suite: string, cases: readonly Case[]): string {
  const failures = cases.filter((c) => c.failure !== undefined).length;
  const skipped = cases.filter((c) => c.skipped === true).length;
  const body = cases.map((c) => {
    const open = `    <testcase name="${escapeXml(c.name)}" classname="${escapeXml(c.classname)}" file="${escapeXml(c.file)}"`;
    if (c.failure !== undefined) {
      return `${open}>\n      <failure message="${escapeXml(c.failure)}"/>\n    </testcase>`;
    }
    return c.skipped === true ? `${open}>\n      <skipped/>\n    </testcase>` : `${open}/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${String(cases.length)}" failures="${String(failures)}" skipped="${String(skipped)}">`,
    `  <testsuite name="${escapeXml(suite)}" tests="${String(cases.length)}" failures="${String(failures)}" skipped="${String(skipped)}">`,
    ...body,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

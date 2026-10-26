import type { TalosConfig } from '../../config/schema.js';

/**
 * The licences every SVP-Labs repository may depend on: permissive ones, public-domain
 * dedications, and attribution-only data licences. A project adds others under `licences` in
 * `talos.yml`, each with its reason.
 */
const ORG_LICENCES: readonly string[] = [
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'PSF-2.0',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'WTFPL',
  'Zlib',
];

/** The org's licences and the project's additions. */
export function allowedLicences(config: TalosConfig): string[] {
  return [...new Set([...ORG_LICENCES, ...Object.keys(config.licences)])];
}

function strip(expression: string): string {
  let text = expression.trim();
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  return text;
}

/**
 * Whether an SPDX expression is satisfied by the allowed licences: `OR` needs one side, `AND`
 * both. Enough for the flat expressions lockfiles record; osv-scanner judges the rest.
 */
export function satisfies(expression: string, allowed: readonly string[]): boolean {
  const text = strip(expression);
  const either = text.split(/ OR /i);
  if (either.length > 1) return either.some((part) => satisfies(part, allowed));
  const both = text.split(/ AND /i);
  if (both.length > 1) return both.every((part) => satisfies(part, allowed));
  return allowed.some((licence) => licence.toLowerCase() === text.toLowerCase());
}

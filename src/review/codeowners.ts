import type { GitHub } from '../github/api.js';
import { readFileAt } from '../github/contents.js';

/** Where GitHub looks for CODEOWNERS, in the order it looks. */
const LOCATIONS: readonly string[] = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/**
 * The default owners a CODEOWNERS file names: the people on its last `*` rule, which owns every
 * file no later rule claims. Teams and e-mail addresses are left out: neither is one login.
 */
export function defaultOwners(text: string): string[] {
  let owners: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const [pattern, ...rest] = line.split(/\s+/);
    if (pattern !== '*') continue;
    owners = rest.filter((o) => /^@[\w-]+$/.test(o)).map((o) => o.slice(1));
  }
  return owners;
}

/** The default owners in the repository's CODEOWNERS at `ref`; empty when it has none. */
export async function codeOwnersAt(gh: GitHub, repo: string, ref: string): Promise<string[]> {
  for (const path of LOCATIONS) {
    const text = await readFileAt(gh, repo, path, ref);
    if (text !== undefined) return defaultOwners(text);
  }
  return [];
}

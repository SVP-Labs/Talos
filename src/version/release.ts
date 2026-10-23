import { z } from 'zod';
import { VersionError } from './errors.js';
import { PACKAGE } from './provenance.js';
import type { GitHub } from '../github/api.js';
import { readFileAt } from '../github/contents.js';

/** An exact `X.Y.Z` with an optional pre-release: what a release tag's `package.json` holds. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;

export type Release = { readonly version: string; readonly sha: string };

const manifestSchema = z.object({ name: z.literal(PACKAGE), version: z.string().regex(VERSION) });

/** The version in a `package.json`'s text, if it is Talos's. */
export function versionOf(text: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = manifestSchema.safeParse(raw);
  return parsed.success ? parsed.data.version : undefined;
}

/**
 * The version a pin enforces: pins only point at release-tag commits, so `package.json` at the
 * pinned commit names the release.
 */
export async function versionAt(gh: GitHub, talosRepo: string, sha: string): Promise<string> {
  const text = await readFileAt(gh, talosRepo, 'package.json', sha);
  const version = text === undefined ? undefined : versionOf(text);
  if (version === undefined) {
    throw new VersionError(`${talosRepo} has no ${PACKAGE} package.json at ${sha.slice(0, 12)}`);
  }
  return version;
}

/** `TALOS_VERSION` and `TALOS_SHA`, which Thea's hub hands to tasks that hold no credentials. */
export function releaseFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Release | undefined {
  const version = env.TALOS_VERSION ?? '';
  const sha = env.TALOS_SHA ?? '';
  if (version === '' && sha === '') return undefined;
  if (!VERSION.test(version) || !COMMIT.test(sha)) {
    throw new VersionError(
      'TALOS_VERSION and TALOS_SHA must be set together: a release version and its 40-hex commit',
    );
  }
  return { version, sha };
}

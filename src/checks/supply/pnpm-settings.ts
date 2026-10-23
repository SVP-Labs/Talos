import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** The minimum release age pnpm must hold, in minutes: a day. */
const MIN_RELEASE_AGE_MINUTES = 1440;

export type PnpmSettings = {
  readonly minimumReleaseAge?: number;
  readonly blockExoticSubdeps?: boolean;
  readonly trustPolicy?: string;
};

const workspace = z.looseObject({
  minimumReleaseAge: z.coerce.number().optional(),
  blockExoticSubdeps: z.boolean().optional(),
  trustPolicy: z.string().optional(),
});

/** `.npmrc` is `key=value` lines; `#` and `;` start comments. */
function npmrcValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const equals = line.indexOf('=');
    const key = line.slice(0, Math.max(equals, 0)).trim();
    if (equals > 0 && /^[\w.-]+$/.test(key)) values.set(key, line.slice(equals + 1).trim());
  }
  return values;
}

function fromNpmrc(values: ReadonlyMap<string, string>): PnpmSettings {
  const age = values.get('minimum-release-age');
  const exotic = values.get('block-exotic-subdeps');
  const trust = values.get('trust-policy');
  return {
    ...(age === undefined || Number.isNaN(Number(age)) ? {} : { minimumReleaseAge: Number(age) }),
    ...(exotic === undefined ? {} : { blockExoticSubdeps: exotic === 'true' }),
    ...(trust === undefined ? {} : { trustPolicy: trust }),
  };
}

function fromWorkspace(text: string | undefined): PnpmSettings {
  if (text === undefined) return {};
  try {
    const parsed = workspace.safeParse(parse(text) ?? {});
    if (!parsed.success) return {};
    const { minimumReleaseAge, blockExoticSubdeps, trustPolicy } = parsed.data;
    return {
      ...(minimumReleaseAge === undefined ? {} : { minimumReleaseAge }),
      ...(blockExoticSubdeps === undefined ? {} : { blockExoticSubdeps }),
      ...(trustPolicy === undefined ? {} : { trustPolicy }),
    };
  } catch {
    return {};
  }
}

/** pnpm reads its settings from `pnpm-workspace.yaml`, which wins over `.npmrc`. */
export function pnpmSettings(workspaceText: string | undefined, npmrcText: string | undefined) {
  return { ...fromNpmrc(npmrcValues(npmrcText ?? '')), ...fromWorkspace(workspaceText) };
}

async function maybeRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The settings pnpm applies to the project whose lockfile is at `lockfile`. */
export async function pnpmSettingsAt(root: string, lockfile: string): Promise<PnpmSettings> {
  const dir = join(root, posix.dirname(lockfile));
  const [workspaceText, npmrcText] = await Promise.all([
    maybeRead(join(dir, 'pnpm-workspace.yaml')),
    maybeRead(join(dir, '.npmrc')),
  ]);
  return pnpmSettings(workspaceText, npmrcText);
}

/** What each pnpm guard needs, and what goes wrong without it. */
export const PNPM_GUARDS: readonly {
  readonly setting: keyof PnpmSettings;
  readonly holds: (settings: PnpmSettings) => boolean;
  readonly wanted: string;
  readonly risk: string;
}[] = [
  {
    setting: 'minimumReleaseAge',
    holds: (s) => (s.minimumReleaseAge ?? 0) >= MIN_RELEASE_AGE_MINUTES,
    wanted: `minimumReleaseAge: ${MIN_RELEASE_AGE_MINUTES}`,
    risk: 'pnpm would install a release less than a day old',
  },
  {
    setting: 'blockExoticSubdeps',
    holds: (s) => s.blockExoticSubdeps === true,
    wanted: 'blockExoticSubdeps: true',
    risk: 'a dependency of a dependency could come from git or a tarball URL',
  },
  {
    setting: 'trustPolicy',
    holds: (s) => s.trustPolicy === 'no-downgrade',
    wanted: 'trustPolicy: no-downgrade',
    risk: 'pnpm would install a release with less provenance than the ones before it',
  },
];

/** pnpm refuses a provenance downgrade itself only under `trustPolicy: no-downgrade`. */
export const enforcesTrust = (settings: PnpmSettings): boolean =>
  settings.trustPolicy === 'no-downgrade';

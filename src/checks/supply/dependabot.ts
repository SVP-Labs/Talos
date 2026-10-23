import picomatch from 'picomatch';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Ecosystem } from '../../adopt/dependabot.js';

type DayCount = 'default-days' | 'semver-major-days' | 'semver-minor-days' | 'semver-patch-days';

/** Every day count a cooldown can set, its default first. */
const DAYS: readonly DayCount[] = [
  'default-days',
  'semver-major-days',
  'semver-minor-days',
  'semver-patch-days',
];

const cooldown = z.looseObject({
  'default-days': z.number().optional(),
  'semver-major-days': z.number().optional(),
  'semver-minor-days': z.number().optional(),
  'semver-patch-days': z.number().optional(),
  exclude: z.array(z.string()).default([]),
});

const update = z.looseObject({
  'package-ecosystem': z.string(),
  directory: z.string().optional(),
  directories: z.array(z.string()).optional(),
  cooldown: cooldown.optional(),
});

const config = z.looseObject({ updates: z.array(update).default([]) });

type Update = z.infer<typeof update>;

/** One problem with `.github/dependabot.yml`: what it is about, and a sentence. */
export type Gap = { readonly key: string; readonly message: string };

function trimmed(directory: string): string {
  let end = directory.length;
  while (end > 1 && directory.charAt(end - 1) === '/') end -= 1;
  return directory.slice(0, end);
}

function covers(entry: Update, directory: string): boolean {
  const patterns = (entry.directories ?? [entry.directory ?? '/']).map(trimmed);
  return patterns.some(
    (pattern) => pattern === directory || picomatch(pattern, { dot: true })(directory),
  );
}

/**
 * A cooldown holds every version update at least a day: each day count it sets is 1 or more,
 * and it exempts no dependency.
 */
export function holdsADay(held: z.input<typeof cooldown> | undefined): boolean {
  if (held === undefined) return false;
  const days = DAYS.map((key) => held[key]);
  const [defaultDays] = days;
  if (defaultDays === undefined || defaultDays < 1) return false;
  return (
    days.every((value) => value === undefined || value >= 1) && (held.exclude ?? []).length === 0
  );
}

function missingEcosystems(updates: readonly Update[], wanted: readonly Ecosystem[]): Gap[] {
  return wanted.flatMap((ecosystem) =>
    ecosystem.directories.flatMap((directory): Gap[] => {
      const entries = updates.filter((u) => u['package-ecosystem'] === ecosystem.ecosystem);
      if (entries.some((entry) => covers(entry, directory))) return [];
      return [
        {
          key: `dependabot ${ecosystem.ecosystem} ${directory}`,
          message: `has no ${ecosystem.ecosystem} entry for ${directory}, so Dependabot proposes no updates there.`,
        },
      ];
    }),
  );
}

/** What `.github/dependabot.yml` lacks for the ecosystems the repository has. */
export function dependabotGaps(text: string | undefined, wanted: readonly Ecosystem[]): Gap[] {
  if (text === undefined) {
    const names = [...new Set(wanted.map((e) => e.ecosystem))].join(', ');
    return [
      {
        key: 'dependabot file',
        message: `is missing; it needs an entry with a one-day cooldown for each ecosystem here: ${names}.`,
      },
    ];
  }
  let parsed: z.infer<typeof config>;
  try {
    parsed = config.parse(parse(text) ?? {});
  } catch {
    return [{ key: 'dependabot file', message: 'cannot be read as a Dependabot configuration.' }];
  }
  const loose = parsed.updates
    .filter((entry) => !holdsADay(entry.cooldown))
    .map((entry) => ({
      key: `dependabot cooldown ${entry['package-ecosystem']} ${entry.directory ?? ''}`,
      message: `lets ${entry['package-ecosystem']} updates through before they are a day old: give the entry a cooldown with default-days of 1 or more and no exclusions.`,
    }));
  return [...loose, ...missingEcosystems(parsed.updates, wanted)];
}

import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { dependabotGaps } from './dependabot.js';
import { lockfiles } from './lockfiles/index.js';
import { PNPM_GUARDS, pnpmSettingsAt } from './pnpm-settings.js';
import { DEPENDABOT_PATH, ecosystems } from '../../adopt/dependabot.js';
import { APPLIES, type Check, type CheckContext } from '../../core/check.js';
import type { Finding, Location } from '../../core/finding.js';

const RULE = 'supply/setting';

async function maybeRead(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

/** The whole file, so a change to it touches the finding; nothing when it doesn't exist. */
function wholeFile(path: string, text: string | undefined): { location?: Location } {
  if (text === undefined) return {};
  const lines = Math.max(1, text.replace(/\r?\n$/, '').split(/\r?\n/).length);
  return { location: { file: path, line: 1, endLine: lines } };
}

async function pnpmFindings(ctx: CheckContext, lockfile: string): Promise<Finding[]> {
  const dir = posix.dirname(lockfile);
  const file = dir === '.' ? 'pnpm-workspace.yaml' : `${dir}/pnpm-workspace.yaml`;
  const settings = await pnpmSettingsAt(ctx.root, lockfile);
  const where = wholeFile(file, await maybeRead(ctx.root, file));
  return PNPM_GUARDS.filter((guard) => !guard.holds(settings)).map((guard) => ({
    rule: RULE,
    key: `pnpm ${dir} ${guard.setting}`,
    message: `${file} must set ${guard.wanted}; without it ${guard.risk}.`,
    ...where,
  }));
}

const DATE_HOURS: Readonly<Record<string, number>> = { Y: 365 * 24, M: 30 * 24, W: 7 * 24, D: 24 };
const TIME_HOURS: Readonly<Record<string, number>> = { H: 1, M: 1 / 60, S: 1 / 3600 };

/** One half of a duration (`1W2D` or `12H30M`) in hours; `undefined` when it isn't one. */
function partHours(part: string, units: Readonly<Record<string, number>>): number | undefined {
  let hours = 0;
  let amount = '';
  for (const char of part) {
    const per = units[char];
    if (per === undefined) {
      if (!/[\d.]/.test(char)) return undefined;
      amount += char;
      continue;
    }
    if (amount === '' || Number.isNaN(Number(amount))) return undefined;
    hours += Number(amount) * per;
    amount = '';
  }
  return amount === '' ? hours : undefined;
}

/** An ISO 8601 duration such as uv's `P1D`, in hours; `undefined` when it isn't one. */
export function durationHours(span: string): number | undefined {
  if (!span.startsWith('P') || span === 'P' || span.endsWith('T')) return undefined;
  const [date = '', time = '', extra] = span.slice(1).split('T');
  if (extra !== undefined) return undefined;
  const dateHours = partHours(date, DATE_HOURS);
  const timeHours = partHours(time, TIME_HOURS);
  return dateHours === undefined || timeHours === undefined ? undefined : dateHours + timeHours;
}

const uvOptions = z.looseObject({
  options: z.looseObject({ 'exclude-newer-span': z.string().optional() }).default({}),
});

/** uv records a relative `exclude-newer` in the lockfile's options, as `exclude-newer-span`. */
export function uvHoldsADay(text: string): boolean {
  try {
    const span = uvOptions.parse(parse(text)).options['exclude-newer-span'];
    return span !== undefined && (durationHours(span) ?? 0) >= 24;
  } catch {
    return false;
  }
}

async function uvFindings(ctx: CheckContext, lockfile: string): Promise<Finding[]> {
  const text = await maybeRead(ctx.root, lockfile);
  if (text === undefined || uvHoldsADay(text)) return [];
  return [
    {
      rule: RULE,
      key: `uv ${posix.dirname(lockfile)} exclude-newer`,
      message:
        `${lockfile} was resolved without a relative exclude-newer of a day or more; set ` +
        'exclude-newer = "1 day" under [tool.uv] and lock again.',
      ...wholeFile(lockfile, text),
    },
  ];
}

async function dependabotFindings(ctx: CheckContext): Promise<Finding[]> {
  const text = await maybeRead(ctx.root, DEPENDABOT_PATH);
  const wanted = ecosystems(ctx.config.components, ctx.facts.files);
  return dependabotGaps(text, wanted).map((gap) => ({
    rule: RULE,
    key: gap.key,
    message: `${DEPENDABOT_PATH} ${gap.message}`,
    ...wholeFile(DEPENDABOT_PATH, text),
  }));
}

/**
 * The package manager settings that carry the supply-chain rules where the package manager has
 * them, and Dependabot's one-day cooldown for every ecosystem the repository has.
 */
export function settingsCheck(): Check {
  return {
    id: 'supply/settings',
    tier: 'head',
    scope: 'repo',
    title: "the package managers' and Dependabot's supply-chain settings",
    applies: () => APPLIES,
    run: async (ctx) => {
      const files = lockfiles(ctx.facts);
      const found = await Promise.all([
        ...files.filter((f) => f.endsWith('pnpm-lock.yaml')).map((f) => pnpmFindings(ctx, f)),
        ...files.filter((f) => f.endsWith('uv.lock')).map((f) => uvFindings(ctx, f)),
        dependabotFindings(ctx),
      ]);
      return found.flat();
    },
  };
}

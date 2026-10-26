import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beyond, expired, MAX_ALLOW_DAYS } from './dates.js';
import type { SupplyDeps } from './deps.js';
import { CONFIG_FILE } from '../../config/load.js';
import type { ExceptionEntry, TalosConfig } from '../../config/schema.js';
import { APPLIES, type Check, skip } from '../../core/check.js';
import type { Finding, Location } from '../../core/finding.js';

type Entry = {
  readonly list: 'allow' | 'exceptions';
  readonly name: string;
  readonly entry: ExceptionEntry;
};

function entries(config: TalosConfig): Entry[] {
  const { allow, exceptions } = config.supply_chain;
  return [
    ...Object.entries(allow).map(([name, entry]): Entry => ({ list: 'allow', name, entry })),
    ...Object.entries(exceptions).map(([name, entry]): Entry => ({
      list: 'exceptions',
      name,
      entry,
    })),
  ];
}

/** The line of `talos.yml` that names the entry, so the finding points at it. */
export function entryLine(text: string, name: string): number | undefined {
  const index = text
    .split(/\r?\n/)
    .findIndex(
      (line) =>
        line.includes(`"${name}"`) ||
        line.includes(`'${name}'`) ||
        line.trimStart().startsWith(`${name}:`),
    );
  return index < 0 ? undefined : index + 1;
}

/** What an entry's dates say is wrong with it, if anything. */
export function judgeEntry(item: Entry, now: Date): Omit<Finding, 'location'> | undefined {
  const { list, name, entry } = item;
  if (expired(entry, now)) {
    const what = list === 'allow' ? 'young release' : 'advisory';
    return {
      rule: 'supply/expired',
      key: `${list} ${name}`,
      policy: 'always',
      message: `The supply_chain.${list} entry for ${name} expired on ${entry.expires}; fix the ${what} or renew the entry with a new reason.`,
    };
  }
  if (list === 'allow' && beyond(entry, now, MAX_ALLOW_DAYS)) {
    return {
      rule: 'supply/allow-too-long',
      key: `allow ${name}`,
      message: `The supply_chain.allow entry for ${name} runs to ${entry.expires}; a young release may be allowed for ${MAX_ALLOW_DAYS} days at most.`,
    };
  }
  return undefined;
}

/**
 * `supply_chain` entries past their expiry, which fail every change until they go, and allow
 * entries that reach further than a week.
 */
export function expiredCheck(deps: Pick<SupplyDeps, 'now'>): Check {
  return {
    id: 'supply/expired',
    tier: 'head',
    scope: 'repo',
    title: 'supply_chain allow and exception entries within their expiry',
    applies: (ctx) =>
      entries(ctx.config).length > 0 ? APPLIES : skip('talos.yml has no supply_chain entries'),
    run: async (ctx) => {
      const now = deps.now();
      const text = await readFile(join(ctx.root, CONFIG_FILE), 'utf8').catch(() => '');
      return entries(ctx.config).flatMap((item): Finding[] => {
        const found = judgeEntry(item, now);
        if (found === undefined) return [];
        const line = entryLine(text, item.name);
        const location: Location | undefined =
          line === undefined ? undefined : { file: CONFIG_FILE, line };
        return [location === undefined ? found : { ...found, location }];
      });
    },
  };
}

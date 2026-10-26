import { z } from 'zod';
import type { Declaration } from './declaration.js';
import type { FeedRequest, Fetcher } from './fetchers.js';
import { RUNTIMES, type Runtime } from './runtimes.js';
import { cycleOf, isRelease, leadingRelease } from './versions.js';
import { EngineError } from '../../core/check.js';

/** One release cycle of a runtime, as endoflife.date describes it. */
export type Cycle = {
  /** `8.4`, `22`, `3.13`. */
  readonly name: string;
  /** The cycle's newest release. */
  readonly latest?: string;
  readonly latestDate?: string;
  /** The date its support ends, `YYYY-MM-DD`. */
  readonly eol?: string;
  readonly isEol: boolean;
  /** The date active support ends; after it the cycle gets security releases only. */
  readonly activeUntil?: string;
};

export type RuntimeFeed = {
  readonly cycles: readonly Cycle[];
  /** Releases the vendor flags as security releases; absent when they weren't needed. */
  readonly security?: ReadonlySet<string>;
};

export type Feeds = ReadonlyMap<Runtime, RuntimeFeed>;

const ENDOFLIFE = 'https://endoflife.date/api/v1/products';

export function endOfLifeRequest(product: string): FeedRequest {
  return { name: `endoflife-${product}`, url: `${ENDOFLIFE}/${encodeURIComponent(product)}` };
}

export function phpReleasesRequest(cycle: string): FeedRequest {
  return {
    name: `php-releases-${cycle}`,
    url: `https://www.php.net/releases/index.php?json&version=${encodeURIComponent(cycle)}&max=1000`,
  };
}

export const NODE_INDEX: FeedRequest = {
  name: 'node-index',
  url: 'https://nodejs.org/dist/index.json',
};

function json(name: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError(`the ${name} feed isn't JSON`);
  }
}

function shaped<T>(name: string, schema: z.ZodType<T>, text: string): T {
  const parsed = schema.safeParse(json(name, text));
  if (!parsed.success) throw new EngineError(`the ${name} feed has an unexpected shape`);
  return parsed.data;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date, or `undefined` for anything else the feed puts there (`null`, `true`). */
const date = z
  .union([z.string(), z.boolean()])
  .nullish()
  .transform((value) => (typeof value === 'string' && DATE.test(value) ? value : undefined));

const productSchema = z.object({
  result: z.object({
    releases: z.array(
      z.object({
        name: z.string(),
        isEol: z.boolean().nullish(),
        eolFrom: date,
        eoasFrom: date,
        latest: z.object({ name: z.string(), date }).nullish(),
      }),
    ),
  }),
});

/** endoflife.date's product: each cycle's newest release and end of life. */
export function parseEndOfLife(text: string, product = 'endoflife.date'): Cycle[] {
  return shaped(product, productSchema, text).result.releases.map((release) => {
    const latest = release.latest?.name;
    return {
      name: release.name,
      ...(latest !== undefined && isRelease(latest) ? { latest } : {}),
      ...(release.latest?.date === undefined ? {} : { latestDate: release.latest.date }),
      ...(release.eolFrom === undefined ? {} : { eol: release.eolFrom }),
      isEol: release.isEol === true,
      ...(release.eoasFrom === undefined ? {} : { activeUntil: release.eoasFrom }),
    };
  });
}

const phpUnknownSchema = z.object({ error: z.string() });

const phpSchema = z.record(z.string(), z.object({ tags: z.array(z.string()).nullish() }));

/** php.net's releases of one cycle: those tagged `security`. An unknown cycle has none. */
export function parsePhpReleases(text: string): string[] {
  if (phpUnknownSchema.safeParse(json('php.net', text)).success) return [];
  return Object.entries(shaped('php.net', phpSchema, text))
    .filter(
      ([version, release]) => release.tags?.includes('security') === true && isRelease(version),
    )
    .map(([version]) => version);
}

const nodeSchema = z.array(z.object({ version: z.string(), security: z.boolean().nullish() }));

/** nodejs.org's `index.json`: the releases marked `security: true`. */
export function parseNodeIndex(text: string): string[] {
  return shaped('nodejs.org', nodeSchema, text)
    .filter((release) => release.security === true)
    .map((release) => release.version.replace(/^v/, ''))
    .filter((version) => isRelease(version));
}

async function fetchCycles(fetcher: Fetcher, runtime: Runtime): Promise<Cycle[]> {
  const { product } = RUNTIMES[runtime];
  return parseEndOfLife(await fetcher(endOfLifeRequest(product)), product);
}

/** The cycles of the exact declarations of one runtime. */
function exactCycles(
  declarations: readonly Declaration[],
  runtime: Runtime,
  cycles: readonly Cycle[],
): string[] {
  const names = cycles.map((cycle) => cycle.name);
  const found = declarations
    .filter((d) => d.runtime === runtime && d.exactness === 'exact' && d.version !== undefined)
    .map((d) => cycleOf(leadingRelease(d.version ?? '') ?? '', names))
    .filter((cycle): cycle is string => cycle !== undefined);
  return [...new Set(found)];
}

async function fetchSecurity(
  fetcher: Fetcher,
  runtime: Runtime,
  cycles: readonly string[],
): Promise<ReadonlySet<string> | undefined> {
  const source = RUNTIMES[runtime].security;
  if (cycles.length === 0) return undefined;
  if (source === 'php.net') {
    const texts = await Promise.all(cycles.map((cycle) => fetcher(phpReleasesRequest(cycle))));
    return new Set(texts.flatMap((text) => parsePhpReleases(text)));
  }
  if (source === 'nodejs') return new Set(parseNodeIndex(await fetcher(NODE_INDEX)));
  return undefined;
}

/**
 * The feeds the declarations need: endoflife.date for every runtime declared, and the vendor's
 * security flags for the cycles that an exact declaration pins.
 */
export async function loadFeeds(
  declarations: readonly Declaration[],
  fetcher: Fetcher,
): Promise<Feeds> {
  const runtimes = [...new Set(declarations.map((d) => d.runtime))];
  const entries = await Promise.all(
    runtimes.map(async (runtime): Promise<[Runtime, RuntimeFeed]> => {
      const cycles = await fetchCycles(fetcher, runtime);
      const security = await fetchSecurity(
        fetcher,
        runtime,
        exactCycles(declarations, runtime, cycles),
      );
      return [runtime, { cycles, ...(security === undefined ? {} : { security }) }];
    }),
  );
  return new Map(entries);
}

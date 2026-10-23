import { z } from 'zod';
import { PHPSTAN_PARAMETERS } from './phpstan-config.js';

/** A setting the project's file makes weaker: what it is, in a few words, and what changed. */
export type Weakening = { readonly setting: string; readonly message: string };

/** A line of a project's file that weakens a base, with the sentence that says how. */
export type Located = { readonly line: number; readonly message: string };

type Params = Readonly<Record<string, unknown>>;

const map = z.record(z.string(), z.unknown());

/** The value as a map, when it is one (not a list). */
export function asMap(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return undefined;
  const parsed = map.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function at(params: Params, path: string): unknown {
  let value: unknown = params;
  for (const part of path.split('.')) value = asMap(value)?.[part];
  return value;
}

function shown(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every leaf under a value, by dotted path. */
function leaves(value: unknown, prefix: string): [string, unknown][] {
  const children = asMap(value);
  if (children === undefined) return [[prefix, value]];
  return Object.entries(children).flatMap(([name, child]) => leaves(child, `${prefix}.${name}`));
}

/** Limits where a higher number allows more. */
const LIMITS = ['cognitive_complexity.function', 'cognitive_complexity.class'];

/** Settings whose every leaf must stay as the base has it. */
const EXACT = [
  ...Object.keys(PHPSTAN_PARAMETERS).filter(
    (name) => !['strictRules', 'cognitive_complexity', 'shipmonkDeadCode'].includes(name),
  ),
  'strictRules',
  'shipmonkDeadCode.detect',
];

/** Lists where an entry the base doesn't have lets something through. */
const LISTS: Readonly<Record<string, (entry: string) => string>> = {
  ignoreErrors: (entry) => `ignores errors matching ${entry}`,
  'excludePaths.analyse': (entry) => `leaves ${entry} out of the analysis`,
  'excludePaths.analyseAndScan': (entry) => `leaves ${entry} out of the analysis`,
  universalObjectCratesClasses: (entry) => `lets ${entry} take any property`,
  dynamicConstantNames: (entry) => `treats the constant ${entry} as variable`,
};

function listed(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function added(base: Params, effective: Params): Weakening[] {
  return Object.entries(LISTS).flatMap(([list, says]) => {
    const known = new Set(listed(at(base, list)).map((entry) => JSON.stringify(entry)));
    return listed(at(effective, list))
      .filter((entry) => !known.has(JSON.stringify(entry)))
      .map((entry) => {
        const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
        const shownEntry = typeof entry === 'string' ? `"${entry}"` : text;
        return { setting: `${list} ${text}`, message: says(shownEntry) };
      });
  });
}

/**
 * PHPStan's effective parameters (`dump-parameters`) with the project's extension against the
 * base's alone: a switch or limit changed, or an entry added to a list that lets errors through.
 */
export function weakerPhpstan(base: Params, effective: Params): Weakening[] {
  const exact = EXACT.flatMap((setting) =>
    leaves(at(base, setting), setting)
      .filter(([path, value]) => !same(at(effective, path), value))
      .map(([path]) => ({
        setting: path,
        message: `sets ${path} to ${shown(at(effective, path))}`,
      })),
  );
  const limits = LIMITS.flatMap((setting) => {
    const [was, now] = [at(base, setting), at(effective, setting)];
    return typeof was === 'number' && typeof now === 'number' && now > was
      ? [{ setting, message: `raises ${setting} to ${now}` }]
      : [];
  });
  return [...exact, ...limits, ...added(base, effective)];
}

/** Each `<exclude-pattern>` in the project's PHPMD ruleset, which PHPMD applies to every rule. */
export function phpmdExcludes(text: string): Located[] {
  return text.split(/\r?\n/).flatMap((line, index): Located[] => {
    const match = /<exclude-pattern>([^<]*)<\/exclude-pattern>/.exec(line);
    return match === null
      ? []
      : [
          {
            line: index + 1,
            message:
              `This exclude-pattern leaves files matching "${match[1] ?? ''}" out of PHPMD, ` +
              'which is weaker than phpmd.xml.',
          },
        ];
  });
}

/** Each `<exclude>` in phpunit.xml's `<source>`, which PHPUnit applies to Talos's coverage too. */
export function phpunitExcludes(text: string): Located[] {
  const found: Located[] = [];
  let inSource = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/<source\b/.test(line)) inSource = true;
    if (inSource && /<exclude\b/.test(line)) {
      found.push({
        line: index + 1,
        message:
          'This exclude in <source> leaves code out of the coverage Talos measures, which no ' +
          'project may narrow.',
      });
    }
    if (line.includes('</source>')) inSource = false;
  }
  return found;
}

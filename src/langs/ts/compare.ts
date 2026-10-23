import { isDeepStrictEqual } from 'node:util';
import { STRICT_FAMILY, TSC_FLAGS } from './configs/tsconfig.js';

/** How an effective setting falls short of the base's. */
export type Weakening = {
  readonly subject: string;
  readonly kind: 'off' | 'severity' | 'limit' | 'options' | 'flag';
  readonly how: string;
};

/** Rules whose first option is a limit: a lower one is stricter, a higher one weaker. */
const LIMIT_RULES = new Set([
  'complexity',
  'max-depth',
  'max-nested-callbacks',
  'max-params',
  'max-statements',
  'max-lines',
  'max-lines-per-function',
  'max-len',
  'sonarjs/cognitive-complexity',
  '@stylistic/max-len',
]);

const LIMIT_KEYS = ['max', 'maximum', 'code'] as const;

function severityOf(value: unknown): number {
  if (typeof value === 'number') return value;
  const named: Readonly<Record<string, number>> = { off: 0, warn: 1, error: 2 };
  return typeof value === 'string' ? (named[value] ?? 0) : 0;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The limit a limit rule's options set, and the options without it. */
export function splitLimit(options: readonly unknown[]): { limit?: number; rest: unknown[] } {
  const [first, ...others] = options;
  if (typeof first === 'number') return { limit: first, rest: others };
  if (!isRecord(first)) return { rest: [...options] };
  const key = LIMIT_KEYS.find((name) => typeof first[name] === 'number');
  if (key === undefined) return { rest: [...options] };
  const { [key]: limit, ...remaining } = first;
  if (typeof limit !== 'number') return { rest: [...options] };
  return { limit, rest: Object.keys(remaining).length === 0 ? others : [remaining, ...others] };
}

/** `ignore*`, `skip*` and `allow*` switches may turn off (stricter), never on. */
function lenientEqual(base: unknown, effective: unknown): boolean {
  if (isDeepStrictEqual(base, effective)) return true;
  if (isList(base) && isList(effective)) {
    return (
      base.length === effective.length && base.every((item, i) => lenientEqual(item, effective[i]))
    );
  }
  if (!isRecord(base) || !isRecord(effective)) return false;
  const keys = new Set([...Object.keys(base), ...Object.keys(effective)]);
  return [...keys].every((key) => {
    const relaxing = /^(?:ignore|skip|allow)/.test(key);
    if (relaxing && base[key] === true && effective[key] === false) return true;
    return lenientEqual(base[key], effective[key]);
  });
}

function compareOptions(
  rule: string,
  base: unknown[],
  effective: unknown[],
): Weakening | undefined {
  if (!LIMIT_RULES.has(rule)) {
    return isDeepStrictEqual(base, effective)
      ? undefined
      : { subject: rule, kind: 'options', how: `changes the options of ${rule}` };
  }
  const was = splitLimit(base);
  const now = splitLimit(effective);
  if (was.limit !== undefined && (now.limit === undefined || now.limit > was.limit)) {
    const to = now.limit === undefined ? 'no limit' : String(now.limit);
    return {
      subject: rule,
      kind: 'limit',
      how: `raises the limit of ${rule} from ${was.limit} to ${to}`,
    };
  }
  return lenientEqual(was.rest, now.rest)
    ? undefined
    : { subject: rule, kind: 'options', how: `changes the options of ${rule}` };
}

function asEntry(value: unknown): unknown[] {
  return isList(value) ? [...value] : [value];
}

/** Every rule the base turns on that the effective config switches off, softens or loosens. */
export function weakerRules(
  base: Readonly<Record<string, unknown>>,
  effective: Readonly<Record<string, unknown>>,
): Weakening[] {
  return Object.entries(base).flatMap(([rule, value]): Weakening[] => {
    const [baseSeverity, ...baseOptions] = asEntry(value);
    const wanted = severityOf(baseSeverity);
    if (wanted === 0) return [];
    const [severity, ...options] = asEntry(effective[rule] ?? 0);
    const actual = severityOf(severity);
    if (actual === 0) return [{ subject: rule, kind: 'off', how: `turns off ${rule}` }];
    if (actual < wanted) {
      return [{ subject: rule, kind: 'severity', how: `makes ${rule} a warning` }];
    }
    const changed = compareOptions(rule, baseOptions, options);
    return changed === undefined ? [] : [changed];
  });
}

/** Compiler flags the effective tsconfig (as `tsc --showConfig` prints it) lacks or reverses. */
export function weakerFlags(options: Readonly<Record<string, unknown>>): Weakening[] {
  const pinned = Object.entries(TSC_FLAGS).flatMap(([flag, value]): Weakening[] =>
    options[flag] === value
      ? []
      : [{ subject: flag, kind: 'flag', how: `does not set ${flag} to ${String(value)}` }],
  );
  const family = STRICT_FAMILY.flatMap((flag): Weakening[] =>
    options[flag] === false ? [{ subject: flag, kind: 'flag', how: `turns ${flag} off` }] : [],
  );
  return [...pinned, ...family];
}

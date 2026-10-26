/** A setting's value: a scalar as printed, or the item lines of a list or table. */
type Value = string | readonly string[];

/** A setting a project's config loosens, compared with the base. */
export type Weakening = { readonly setting: string; readonly message: string };

/**
 * `ruff check --show-settings`, read as flat `key = value` lines; a value of `[` or `{` runs to
 * the matching closing line and is kept as its item lines.
 */
export type RuffSettings = {
  readonly values: ReadonlyMap<string, Value>;
  /** Enabled rules: code to name. */
  readonly enabled: ReadonlyMap<string, string>;
  /** Per-file ignores: the pattern as written to the codes it ignores. */
  readonly perFileIgnores: ReadonlyMap<string, readonly string[]>;
};

const ENTRY = /^([a-z][\w.]*) = (.*)$/;

function item(line: string): string {
  return line.trim().replace(/,$/, '');
}

function readValues(lines: readonly string[]): Map<string, string | string[]> {
  const values = new Map<string, string | string[]>();
  let open: { key: string; close: string; items: string[] } | undefined;
  for (const line of lines) {
    if (open) {
      if (line === open.close) {
        values.set(open.key, open.items);
        open = undefined;
      } else open.items.push(line);
      continue;
    }
    const match = ENTRY.exec(line);
    const [, key, value] = match ?? [];
    if (key === undefined || value === undefined) continue;
    if (value === '[' || value === '{') open = { key, close: value === '[' ? ']' : '}', items: [] };
    else values.set(key, value);
  }
  return values;
}

function lines(value: Value | undefined): readonly string[] {
  return value === undefined || typeof value === 'string' ? [] : value;
}

function readEnabled(value: Value | undefined): Map<string, string> {
  const enabled = new Map<string, string>();
  for (const line of lines(value)) {
    const match = /^(\S+) \(([A-Z]+\d+)\)$/.exec(item(line));
    if (match?.[1] !== undefined && match[2] !== undefined) enabled.set(match[2], match[1]);
  }
  return enabled;
}

function readPerFile(value: Value | undefined): Map<string, string[]> {
  const ignores = new Map<string, string[]>();
  let pattern: string | undefined;
  for (const line of lines(value)) {
    const matcher = /^basename_matcher = "(.*)"$/.exec(line.trim());
    if (matcher?.[1] !== undefined) {
      pattern = matcher[1];
      ignores.set(pattern, []);
    }
    const code = /\(([A-Z]+\d+)\),?$/.exec(line.trim())?.[1];
    if (pattern !== undefined && code !== undefined) ignores.get(pattern)?.push(code);
  }
  return ignores;
}

export function parseRuffSettings(text: string): RuffSettings {
  const values = readValues(text.split(/\r?\n/));
  return {
    values,
    enabled: readEnabled(values.get('linter.rules.enabled')),
    perFileIgnores: readPerFile(values.get('linter.per_file_ignores')),
  };
}

/** Lists that allow something a rule would otherwise report: a project may not add to them. */
const ALLOWANCE =
  /^(allow|allowed|ignore|extend_allowed|extend_ignore|extend_immutable|exempt|runtime_evaluated)/;
const ALLOWANCE_KEYS = new Set(['linter.builtins', 'linter.external']);
/** Lists of things a rule looks for: a project may not remove from them. */
const REQUIREMENT = new Set([
  'task_tags',
  'raises_require_match_for',
  'banned_api',
  'banned_module_level_imports',
  'banned_aliases',
  'banned_from',
  'hardcoded_tmp_directory',
]);
/** Switches that silence a rule when on. */
const RELAXING_SWITCH = /^(allow_|ignore_|suppress_|mypy_init_return$)/;
/** The formatter's style, which the standard keeps at ruff format's defaults. */
const FORMAT_STYLE = new Set([
  'formatter.preview',
  'formatter.quote_style',
  'formatter.indent_style',
  'formatter.indent_width',
  'formatter.magic_trailing_comma',
  'formatter.docstring_code_format',
  'formatter.nested_string_quote_style',
]);

function limit(value: string): number {
  return value === 'none' ? Number.POSITIVE_INFINITY : Number(value);
}

function itemsOf(value: Value | undefined): string[] {
  return lines(value)
    .map((line) => item(line))
    .filter((line) => line !== '');
}

function compareList(key: string, base: string[], mine: string[]): Weakening | undefined {
  const name = key.split('.').at(-1) ?? key;
  if (ALLOWANCE.test(name) || ALLOWANCE_KEYS.has(key)) {
    const added = mine.filter((entry) => !base.includes(entry));
    if (added.length > 0) return { setting: key, message: `adds ${added.join(', ')} to ${key}` };
  }
  if (REQUIREMENT.has(name)) {
    const removed = base.filter((entry) => !mine.includes(entry));
    if (removed.length > 0) {
      return { setting: key, message: `removes ${removed.join(', ')} from ${key}` };
    }
  }
  return undefined;
}

function compareScalar(key: string, base: string, mine: string): Weakening | undefined {
  if (base === mine) return undefined;
  const name = key.split('.').at(-1) ?? key;
  if (/^(max_\w+|line_length|line_width)$/.test(name)) {
    return limit(mine) > limit(base)
      ? { setting: key, message: `raises ${key} from ${base} to ${mine}` }
      : undefined;
  }
  if (RELAXING_SWITCH.test(name) && base === 'false' && mine === 'true') {
    return { setting: key, message: `turns on ${key}` };
  }
  if (key === 'linter.dummy_variable_rgx' || FORMAT_STYLE.has(key)) {
    return { setting: key, message: `changes ${key} from ${base} to ${mine}` };
  }
  return undefined;
}

function compareValue(key: string, base: RuffSettings, mine: RuffSettings): Weakening | undefined {
  const theirs = base.values.get(key);
  const ours = mine.values.get(key);
  if (theirs === undefined || ours === undefined) return undefined;
  if (typeof theirs === 'string' && typeof ours === 'string') {
    return compareScalar(key, theirs, ours);
  }
  return compareList(key, itemsOf(theirs), itemsOf(ours));
}

/** Every way the project's effective settings are weaker than the base's. */
export function weakerRuff(base: RuffSettings, mine: RuffSettings): Weakening[] {
  const rules = [...base.enabled]
    .filter(([code]) => !mine.enabled.has(code))
    .map(([code, name]) => ({ setting: `rule ${code}`, message: `turns off ${name} (${code})` }));
  const ignores = [...mine.perFileIgnores].flatMap(([pattern, codes]) => {
    const allowed = base.perFileIgnores.get(pattern) ?? [];
    const extra = codes.filter((code) => !allowed.includes(code));
    return extra.length === 0
      ? []
      : [
          {
            setting: `per-file-ignores ${pattern}`,
            message: `ignores ${extra.join(', ')} in ${pattern}`,
          },
        ];
  });
  const skipped = new Set([
    'linter.rules.enabled',
    'linter.rules.should_fix',
    'linter.per_file_ignores',
  ]);
  const settings = [...mine.values.keys()]
    .filter((key) => !skipped.has(key))
    .flatMap((key) => compareValue(key, base, mine) ?? []);
  return [...rules, ...ignores, ...settings];
}

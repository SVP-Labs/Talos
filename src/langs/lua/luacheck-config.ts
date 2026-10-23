import { z } from 'zod';
import { LUACHECK_OPTIONS } from './configs.js';
import { EngineError } from '../../core/check.js';

const value = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const options = z.array(z.object({ name: z.string(), value }));

const dump = z.union([
  z.object({
    error: z.literal(''),
    top: options,
    files: z.array(z.object({ glob: z.string(), options })),
  }),
  z.object({ error: z.string().min(1) }),
]);

type OptionValue = z.infer<typeof value>;

/** The options luacheck loaded, at the top level and for each `files` pattern. */
export type LoadedConfig = {
  readonly top: ReadonlyMap<string, OptionValue>;
  readonly files: readonly {
    readonly glob: string;
    readonly options: ReadonlyMap<string, OptionValue>;
  }[];
};

/** The config script's output; undefined when the configuration doesn't load (lua/lint says). */
export function parseLoadedConfig(text: string): LoadedConfig | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError(`the luacheck config script printed no JSON: ${text.slice(0, 200)}`);
  }
  const parsed = dump.safeParse(raw);
  if (!parsed.success) throw new EngineError('the luacheck config script printed an unknown shape');
  if (!('top' in parsed.data)) return undefined;
  const toMap = (list: z.infer<typeof options>): Map<string, OptionValue> =>
    new Map(list.map((o) => [o.name, o.value]));
  return {
    top: toMap(parsed.data.top),
    files: parsed.data.files.map((f) => ({ glob: f.glob, options: toMap(f.options) })),
  };
}

/** A setting weaker than the base: `setting` names it, `how` says what it does. */
export type Weakening = { readonly setting: string; readonly how: string };

/** Standards that describe another Lua, or every Lua at once: more globals than Lua 5.4 has. */
const WIDER_STDS = new Set([
  '_G',
  'lua51',
  'lua51c',
  'lua52',
  'lua52c',
  'lua53',
  'lua53c',
  'lua54c',
  'luajit',
  'max',
  'ngx_lua',
]);

/** Standards that may replace lua54: they only take globals away. */
const NARROWER_STDS = new Set(['lua54', 'min', 'none']);

/**
 * A std is no weaker when it keeps lua54 (or narrows it) as its base and adds only the host's
 * globals (`+busted`, `+love`, a project's own std): those describe where the code runs.
 */
export function weakerStd(std: OptionValue): string | undefined {
  if (typeof std !== 'string') return 'sets std to a table of its own instead of lua54';
  const parts = std.split('+').map((part) => part.trim());
  const [base = '', ...added] = parts;
  if (base !== '' && !NARROWER_STDS.has(base)) return `sets std to "${std}" instead of lua54`;
  const wider = added.find((part) => WIDER_STDS.has(part));
  return wider === undefined ? undefined : `adds std "${wider}", another Lua's globals`;
}

/** Switches whose `false` turns a family of warnings off. */
const WARNING_SWITCHES = [
  'global',
  'unused',
  'redefined',
  'unused_args',
  'unused_secondaries',
  'self',
];

/** Switches whose `true` lets code define globals at will, or accept another Lua. */
const RELAXING_SWITCHES = ['allow_defined', 'allow_defined_top', 'compat'];

const LIMITS: Readonly<Record<string, number>> = {
  max_line_length: LUACHECK_OPTIONS.maxLineLength,
  max_code_line_length: LUACHECK_OPTIONS.maxLineLength,
  max_comment_line_length: LUACHECK_OPTIONS.maxLineLength,
  max_cyclomatic_complexity: LUACHECK_OPTIONS.maxCyclomaticComplexity,
};

function asList(option: OptionValue | undefined): readonly string[] {
  return Array.isArray(option) ? option : [];
}

function weakerLimits(options: ReadonlyMap<string, OptionValue>): Weakening[] {
  return Object.entries(LIMITS).flatMap(([setting, limit]): Weakening[] => {
    const set = options.get(setting);
    if (set === undefined || (typeof set === 'number' && set <= limit)) return [];
    const how =
      set === false
        ? `turns ${setting} off`
        : `raises ${setting} to ${JSON.stringify(set)}, over ${limit}`;
    return [{ setting, how }];
  });
}

function weakerSwitches(options: ReadonlyMap<string, OptionValue>): Weakening[] {
  return [
    ...WARNING_SWITCHES.filter((s) => options.get(s) === false).map((setting) => ({
      setting,
      how: `sets ${setting} to false, which turns its warnings off`,
    })),
    ...RELAXING_SWITCHES.filter((s) => options.get(s) === true).map((setting) => ({
      setting,
      how: `sets ${setting} to true`,
    })),
  ];
}

function weakerLists(options: ReadonlyMap<string, OptionValue>): Weakening[] {
  const ignoredByBase = new Set<string>(LUACHECK_OPTIONS.ignore);
  const excludedByBase = new Set<string>(LUACHECK_OPTIONS.excludeFiles);
  return [
    ...asList(options.get('ignore'))
      .filter((pattern) => !ignoredByBase.has(pattern))
      .map((pattern) => ({ setting: `ignore ${pattern}`, how: `ignores "${pattern}"` })),
    ...asList(options.get('only')).map((pattern) => ({
      setting: `only ${pattern}`,
      how: `checks only "${pattern}"`,
    })),
    ...asList(options.get('exclude_files'))
      .filter((glob) => !excludedByBase.has(glob))
      .map((glob) => ({ setting: `exclude_files ${glob}`, how: `skips "${glob}"` })),
    ...asList(options.get('include_files')).map((glob) => ({
      setting: `include_files ${glob}`,
      how: `checks only the files matching "${glob}"`,
    })),
  ];
}

function weakerOptions(options: ReadonlyMap<string, OptionValue>): Weakening[] {
  const std = options.get('std');
  const how = std === undefined ? undefined : weakerStd(std);
  return [
    ...(how === undefined ? [] : [{ setting: 'std', how }]),
    ...weakerLimits(options),
    ...weakerSwitches(options),
    ...weakerLists(options),
  ];
}

/**
 * Every setting of the loaded configuration weaker than the base: at the top level, and in
 * each `files` pattern, which applies on top of it for the files it matches. The base's own
 * values are never weaker, so whatever is reported came from the project.
 */
export function weakerLuacheck(config: LoadedConfig): Weakening[] {
  return [
    ...weakerOptions(config.top),
    ...config.files.flatMap(({ glob, options }) =>
      weakerOptions(options).map((w) => ({
        setting: `files["${glob}"] ${w.setting}`,
        how: `for "${glob}" ${w.how}`,
      })),
    ),
  ];
}

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

/** The settings mutmut runs with, from the file and table it reads them from. */
export type MutmutSettings = {
  readonly file: 'pyproject.toml' | 'setup.cfg';
  readonly table: '[tool.mutmut]' | '[mutmut]';
  readonly values: Readonly<Record<string, unknown>>;
};

const table = z.record(z.string(), z.unknown());
const pyprojectTool = z.object({ tool: z.object({ mutmut: table }).optional() });

/** One line of a section into its values; the key a continuation line after it adds to. */
function addLine(
  values: Record<string, string>,
  key: string | undefined,
  line: string,
): string | undefined {
  const trimmed = line.trim();
  if (/^\s/.test(line) && key !== undefined) {
    values[key] = `${values[key] ?? ''}\n${trimmed}`;
    return key;
  }
  const match = /^([^=:]+)[=:](.*)$/.exec(trimmed);
  const named = match?.[1]?.trim().toLowerCase();
  if (named !== undefined) values[named] = match?.[2]?.trim() ?? '';
  return named;
}

/**
 * A section of an INI file as Python's config parser reads it: keys lower-cased, `=` or `:`
 * between key and value, a line that starts with whitespace continuing the value before it, and
 * blank and comment lines left out.
 */
function iniSection(text: string, name: string): Record<string, string> | undefined {
  let values: Record<string, string> | undefined;
  let inside = false;
  let key: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = /^\[(.+)\]$/.exec(trimmed)?.[1];
    if (section !== undefined) {
      inside = section.trim() === name;
      if (inside) values ??= {};
      key = undefined;
    } else if (inside && values !== undefined && trimmed !== '' && !/^[#;]/.test(trimmed)) {
      key = addLine(values, key, line);
    }
  }
  return values;
}

/**
 * The settings mutmut reads: `pyproject.toml`'s `[tool.mutmut]` when it has one, else
 * `setup.cfg`'s `[mutmut]`. `undefined` with neither, or when the file mutmut would read can't be
 * parsed, since mutmut then stops before mutating anything.
 */
export function mutmutSettings(
  pyproject: string | undefined,
  setupCfg: string | undefined,
): MutmutSettings | undefined {
  if (pyproject !== undefined) {
    let parsed: unknown;
    try {
      parsed = parseToml(pyproject);
    } catch {
      return undefined;
    }
    const tool = pyprojectTool.safeParse(parsed);
    if (!tool.success) return undefined;
    const mutmut = tool.data.tool?.mutmut;
    if (mutmut !== undefined) {
      return { file: 'pyproject.toml', table: '[tool.mutmut]', values: mutmut };
    }
  }
  const section = setupCfg === undefined ? undefined : iniSection(setupCfg, 'mutmut');
  return section === undefined
    ? undefined
    : { file: 'setup.cfg', table: '[mutmut]', values: section };
}

/** A list setting as mutmut takes it: a TOML array, or `setup.cfg`'s lines. */
function listOf(value: unknown): string[] {
  if (typeof value === 'string') return value.split('\n').filter((line) => line !== '');
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/** A switch as mutmut takes it: a TOML boolean, or `setup.cfg`'s `1`, `t` or `true`. */
function isOn(value: unknown): boolean {
  if (typeof value === 'string') return ['1', 't', 'true'].includes(value.toLowerCase());
  return value === true;
}

/** Whether a number setting is below `floor`; one mutmut can't read as a number stops it. */
function isBelow(value: unknown, floor: number): boolean {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && number < floor;
}

/** mutmut's own timeouts, which Talos runs with. */
const TIMEOUT_MULTIPLIER = 15;
const TIMEOUT_CONSTANT = 1;

const WEAKENING_SETTINGS: readonly {
  readonly setting: string;
  readonly how: string;
  readonly weakens: (value: unknown) => boolean;
}[] = [
  {
    setting: 'only_mutate',
    how: 'mutates only the files it names',
    weakens: (v) => listOf(v).length > 0,
  },
  {
    setting: 'do_not_mutate',
    how: 'never mutates the files it names',
    weakens: (v) => listOf(v).length > 0,
  },
  {
    setting: 'do_not_mutate_patterns',
    how: 'never mutates the lines it matches',
    weakens: (v) => listOf(v).length > 0,
  },
  {
    setting: 'mutate_only_covered_lines',
    how: 'never mutates the lines no test covers',
    weakens: isOn,
  },
  {
    setting: 'type_check_command',
    how: 'counts a mutant its command rejects as killed, though no test failed',
    weakens: (v) => listOf(v).length > 0,
  },
  {
    setting: 'timeout_multiplier',
    how: 'lowers the timeout, and a mutant that times out counts as killed',
    weakens: (v) => isBelow(v, TIMEOUT_MULTIPLIER),
  },
  {
    setting: 'timeout_constant',
    how: 'lowers the timeout, and a mutant that times out counts as killed',
    weakens: (v) => isBelow(v, TIMEOUT_CONSTANT),
  },
];

/**
 * Each setting that never runs a mutant, or counts one as killed without a test failing.
 * Talos's runner takes the project's mutmut settings as they are, so any of these weakens
 * mutation; the rest (files to copy, pytest's arguments, which tests to select) changes no
 * mutant's fate, or only makes one harder to kill.
 */
export function weakerMutmut(
  values: Readonly<Record<string, unknown>>,
): { readonly setting: string; readonly how: string }[] {
  return WEAKENING_SETTINGS.filter((w) => w.setting in values && w.weakens(values[w.setting])).map(
    ({ setting, how }) => ({ setting, how }),
  );
}

/** A path as mutmut's `Path` reads it, relative to the component's root; `''` for the root. */
function normalised(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
}

/**
 * The paths mutmut mutates under: `source_paths`, else the older `paths_to_mutate`, else its
 * guess, `lib` or else `src` where the component has one; `undefined` when it would guess none,
 * since it then stops.
 */
function sourcePaths(
  values: Readonly<Record<string, unknown>>,
  files: readonly string[],
): string[] | undefined {
  const named = listOf(values.source_paths);
  const given = named.length > 0 ? named : listOf(values.paths_to_mutate);
  if (given.length > 0) return given.map((path) => normalised(path));
  const guess = ['lib', 'src'].find((dir) => files.some((file) => file.startsWith(`${dir}/`)));
  return guess === undefined ? undefined : [guess];
}

/**
 * The targets, files under talos.yml's mutation paths relative to the component's root, that no
 * path mutmut mutates under holds: a file mutmut never copies is never mutated, so no mutant of
 * it can survive.
 */
export function outsideSourcePaths(
  values: Readonly<Record<string, unknown>>,
  targets: readonly string[],
  files: readonly string[],
): string[] {
  const paths = sourcePaths(values, files);
  if (paths === undefined) return [];
  return targets.filter(
    (file) => !paths.some((path) => path === '' || file === path || file.startsWith(`${path}/`)),
  );
}

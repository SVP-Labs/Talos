import {
  eolOf,
  insertLines,
  joinToml,
  keyLine,
  parsedToml,
  replaceLine,
  sameToml,
  splitToml,
  type TomlSection,
  within,
} from './toml-text.js';
import { durationHours } from '../checks/supply/settings.js';

/**
 * A Python component's `pyproject.toml` as Talos wants it. Its `[tool.ruff]` and
 * `[tool.basedpyright]` (or `[tool.pyright]`) move into `ruff.toml` and `pyrightconfig.json`,
 * the extension files of Talos's bases, which the tools read first and which would otherwise
 * leave the project's settings silently unread. `[tool.mypy]` goes: basedpyright replaces mypy.
 */

/** Builds an extension file's first text from the initial text its pack writes. */
export type Seed = (initial: string) => string;

export type PyprojectMigration = {
  /** The new `pyproject.toml`, when it changes. */
  readonly text?: string;
  /** Seeds for the extension files, by their name in the component. */
  readonly seeds: ReadonlyMap<string, Seed>;
  /** Why something was left for a person, when it was. */
  readonly manual?: string;
};

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * In a file that extends the base, these would replace the base's lists instead of adding to
 * them: its rule selection, its test-file ignores and ruff's default excludes.
 */
const RUFF_RENAMES: Readonly<Record<string, string>> = {
  select: 'extend-select',
  'lint.select': 'lint.extend-select',
  'per-file-ignores': 'extend-per-file-ignores',
  'lint.per-file-ignores': 'lint.extend-per-file-ignores',
  exclude: 'extend-exclude',
};

function renamedRuff(settings: Table): Table {
  const out: Table = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'lint' && isTable(value)) {
      const lint: Table = {};
      for (const [inner, v] of Object.entries(value)) {
        lint[(RUFF_RENAMES[`lint.${inner}`] ?? `lint.${inner}`).slice(5)] = v;
      }
      out.lint = lint;
    } else {
      out[RUFF_RENAMES[key] ?? key] = value;
    }
  }
  return out;
}

const KEY = /^(\s*)([\w.-]+)(\s*=)/;

/** One `[tool.ruff…]` section as it reads in `ruff.toml`. */
function ruffSection(section: TomlSection): TomlSection {
  const rel = (section.name ?? '').slice('tool.ruff'.length).replace(/^\./, '');
  const lines = section.lines.map((line, index) => {
    if (!section.top[index]) return line;
    if (/^\s*\[/.test(line)) {
      const name = RUFF_RENAMES[rel] ?? rel;
      return rel === '' ? '' : `[${name}]`;
    }
    return line.replace(KEY, (whole, space: string, key: string, eq: string) => {
      const full = rel === '' ? key : `${rel}.${key}`;
      const renamed = RUFF_RENAMES[full];
      return renamed === undefined
        ? whole
        : `${space}${renamed.slice(full.length - key.length)}${eq}`;
    });
  });
  const header = section.lines.findIndex((line, i) => section.top[i] && /^\s*\[/.test(line));
  return {
    ...section,
    lines: rel === '' ? lines.filter((_, i) => i !== header) : lines,
    top: rel === '' ? section.top.filter((_, i) => i !== header) : section.top,
  };
}

/** `ruff.toml`'s text after the base's `extend`, or why the settings can't move as text. */
function ruffFragment(sections: readonly TomlSection[], settings: Table): string | undefined {
  if (sections.some((s) => s.array)) return undefined;
  const moved = sections.map(ruffSection);
  const root = moved.filter((s) => s.name === 'tool.ruff');
  const rest = moved.filter((s) => s.name !== 'tool.ruff');
  const fragment = joinToml([...root, ...rest]);
  const parsed = parsedToml(fragment);
  return parsed !== undefined && sameToml(parsed, renamedRuff(settings)) ? fragment : undefined;
}

function pyrightSeed(settings: Table): Seed | undefined {
  if ('extends' in settings) return undefined;
  return (initial) => {
    const lines = initial.split('\n');
    const comments = lines.filter((line) => line.startsWith('//'));
    const json: unknown = JSON.parse(lines.filter((line) => !line.startsWith('//')).join('\n'));
    const merged = { ...(isTable(json) ? json : {}), ...settings };
    return `${[...comments, JSON.stringify(merged, null, 2)].join('\n')}\n`;
  };
}

function toolOf(parsed: Table): Table {
  return isTable(parsed.tool) ? parsed.tool : {};
}

function without(parsed: Table, tools: readonly string[]): Table {
  const tool = Object.fromEntries(
    Object.entries(toolOf(parsed)).filter(([name]) => !tools.includes(name)),
  );
  const { tool: _, ...rest } = parsed;
  return Object.keys(tool).length === 0 ? rest : { ...rest, tool };
}

type Has = { readonly ruff: boolean; readonly pyright: boolean };

type Moves = { readonly ruff?: Table; readonly pyright?: Table; readonly gone: readonly string[] };

/** basedpyright reads `[tool.basedpyright]` over `[tool.pyright]`. */
function pyrightSettings(tool: Table): { names: string[]; settings: Table } | undefined {
  const names = ['pyright', 'basedpyright'].filter((name) => isTable(tool[name]));
  if (names.length === 0) return undefined;
  const settings: Table = {};
  for (const name of names) {
    const table = tool[name];
    if (isTable(table)) Object.assign(settings, table);
  }
  return { names, settings };
}

/** Which tables move and which go, by the tools they configure. */
function plannedMoves(parsed: Table, has: Has): Moves {
  const tool = toolOf(parsed);
  const ruff = !has.ruff && isTable(tool.ruff) ? tool.ruff : undefined;
  const pyright = has.pyright ? undefined : pyrightSettings(tool);
  return {
    ...(ruff === undefined ? {} : { ruff }),
    ...(pyright === undefined ? {} : { pyright: pyright.settings }),
    gone: [
      ...('mypy' in tool ? ['mypy'] : []),
      ...(ruff === undefined ? [] : ['ruff']),
      ...(pyright?.names ?? []),
    ],
  };
}

/**
 * The migration of one `pyproject.toml`. `has` says which extension files the component has
 * already: the tools read those, so the tables they shadow stay as they are.
 */
export function migratePyproject(text: string, has: Has): PyprojectMigration {
  const parsed = parsedToml(text);
  if (parsed === undefined) return { seeds: new Map(), manual: 'pyproject.toml is not valid TOML' };
  const moves = plannedMoves(parsed, has);
  if (moves.gone.length === 0) return { seeds: new Map() };
  const sections = splitToml(text);
  const seeds = new Map<string, Seed>();
  if (moves.ruff !== undefined) {
    if ('extend' in moves.ruff) return { seeds, manual: 'its [tool.ruff] extends another file' };
    const fragment = ruffFragment(
      sections.filter((s) => within(s.name, 'tool.ruff')),
      moves.ruff,
    );
    if (fragment === undefined) return { seeds, manual: 'its [tool.ruff] is laid out unusually' };
    seeds.set('ruff.toml', (initial) => `${initial}\n${fragment}`);
  }
  if (moves.pyright !== undefined) {
    const seed = pyrightSeed(moves.pyright);
    if (seed === undefined) {
      return { seeds: new Map(), manual: 'its pyright settings extend a file' };
    }
    seeds.set('pyrightconfig.json', seed);
  }
  const kept = sections.filter((s) => !moves.gone.some((tool) => within(s.name, `tool.${tool}`)));
  const next = joinToml(kept, eolOf(text));
  const reparsed = parsedToml(next);
  if (reparsed === undefined || !sameToml(reparsed, without(parsed, moves.gone))) {
    return { seeds: new Map(), manual: 'its [tool] tables are laid out unusually' };
  }
  return { text: next, seeds };
}

/** A relative `exclude-newer` of a day or more: `1 day`, `2 weeks`, `24 hours` or `P1D`. */
export function holdsADay(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const friendly = /^(\d+)\s*(hours?|days?|weeks?)$/i.exec(value.trim());
  if (friendly === null) return (durationHours(value.trim().toUpperCase()) ?? 0) >= 24;
  const unit = (friendly[2] ?? '').toLowerCase().replace(/s$/, '');
  const hours = Number(friendly[1]) * ({ hour: 1, day: 24, week: 168 }[unit] ?? 0);
  return hours >= 24;
}

const UV_LINE = 'exclude-newer = "1 day"';

function withUvLine(sections: readonly TomlSection[]): TomlSection[] {
  const index = sections.findIndex((s) => s.name === 'tool.uv' && !s.array);
  const section = sections[index];
  if (section === undefined) {
    const last = sections.at(-1)?.lines.at(-1);
    const lines = [...(last === undefined || last.trim() === '' ? [] : ['']), '[tool.uv]', UV_LINE];
    return [...sections, { name: 'tool.uv', array: false, lines, top: lines.map(() => true) }];
  }
  const at = keyLine(section, 'exclude-newer');
  if (at !== -1) return sections.map((s, i) => (i === index ? replaceLine(s, at, UV_LINE) : s));
  const header = section.lines.findIndex((line, i) => section.top[i] && /^\s*\[/.test(line));
  return sections.map((s, i) => (i === index ? insertLines(s, header + 1, [UV_LINE]) : s));
}

/**
 * `[tool.uv] exclude-newer = "1 day"`, so uv resolves only releases at least a day old and
 * records the span in `uv.lock`. A span of a day or more stays as it is.
 */
export function holdUvADay(text: string): { text?: string; manual?: string } {
  const parsed = parsedToml(text);
  if (parsed === undefined) return { manual: 'pyproject.toml is not valid TOML' };
  const uv = toolOf(parsed).uv;
  if (isTable(uv) && holdsADay(uv['exclude-newer'])) return {};
  const next = joinToml(withUvLine(splitToml(text)), eolOf(text));
  const tool = toolOf(parsed);
  const wanted = {
    ...parsed,
    tool: { ...tool, uv: { ...(isTable(uv) ? uv : {}), 'exclude-newer': '1 day' } },
  };
  const reparsed = parsedToml(next);
  return reparsed !== undefined && sameToml(reparsed, wanted)
    ? { text: next }
    : { manual: 'its [tool.uv] could not be edited safely' };
}

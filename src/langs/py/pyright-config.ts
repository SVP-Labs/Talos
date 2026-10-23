import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { Weakening } from './ruff-settings.js';

type Settings = Readonly<Record<string, unknown>>;

const settings = z.record(z.string(), z.unknown());

/**
 * pyright's config files are JSON with comments and trailing commas; this removes both,
 * leaving strings alone.
 */
export function stripJsonComments(text: string): string {
  const comments = /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  const trailing = /"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g;
  return text
    .replaceAll(comments, (token) => (token.startsWith('"') ? token : ' '))
    .replaceAll(trailing, (token) => (token.startsWith('"') ? token : ''));
}

function fromToml(text: string): Settings {
  const tool = settings.safeParse(parseToml(text).tool);
  if (!tool.success) return {};
  const section = settings.safeParse(tool.data.basedpyright ?? tool.data.pyright);
  return section.success ? section.data : {};
}

/** One config file's own settings: a JSON file, or `[tool.basedpyright]` of a pyproject.toml. */
export function readPyrightFile(name: string, text: string): Settings {
  try {
    if (basename(name) === 'pyproject.toml') return fromToml(text);
    const parsed = settings.safeParse(JSON.parse(stripJsonComments(text)));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The settings basedpyright ends up with: each file's over the file it `extends`. */
export async function resolvePyright(path: string, depth = 0): Promise<Settings> {
  let own: Settings;
  try {
    own = readPyrightFile(path, await readFile(path, 'utf8'));
  } catch {
    return {};
  }
  const { extends: parent, ...rest } = own;
  if (typeof parent !== 'string' || depth > 8) return rest;
  return { ...(await resolvePyright(join(dirname(path), parent), depth + 1)), ...rest };
}

/** Settings that "all" turns on and a project may not turn off. */
const MUST_BE_ON = new Set([
  'strictListInference',
  'strictSetInference',
  'strictDictionaryInference',
  'analyzeUnannotatedFunctions',
  'strictParameterNoneValue',
  'enableReachabilityAnalysis',
  'deprecateTypingAliases',
  'disableBytesTypePromotions',
  'failOnWarnings',
  'strictGenericNarrowing',
]);

function weakening(key: string, value: unknown): string | undefined {
  const shown = JSON.stringify(value);
  if (key.startsWith('report')) return value === 'error' || value === true ? undefined : shown;
  if (MUST_BE_ON.has(key)) return value === false ? shown : undefined;
  if (key === 'enableTypeIgnoreComments') return value === true ? shown : undefined;
  if (key === 'ignore' || key === 'allowedUntypedLibraries') {
    return z.array(z.unknown()).min(1).safeParse(value).success ? shown : undefined;
  }
  return undefined;
}

function weakerSettings(entries: Settings, where: string): Weakening[] {
  return Object.entries(entries).flatMap(([key, value]) => {
    const shown = weakening(key, value);
    return shown === undefined
      ? []
      : [{ setting: `${where}${key}`, message: `sets ${where}${key} to ${shown}` }];
  });
}

const environment = z.object({ root: z.string() }).catchall(z.unknown());

/** Every way resolved basedpyright settings are weaker than "all" with nothing switched off. */
export function weakerPyright(resolved: Settings): Weakening[] {
  const mode = resolved.typeCheckingMode;
  const modeWeakening =
    mode === 'all'
      ? []
      : [
          {
            setting: 'typeCheckingMode',
            message: `sets typeCheckingMode to ${JSON.stringify(mode ?? 'recommended')}`,
          },
        ];
  const environments = z.array(environment).safeParse(resolved.executionEnvironments);
  const scoped = (environments.success ? environments.data : []).flatMap(({ root, ...rest }) =>
    weakerSettings(rest, `executionEnvironments[${root}].`),
  );
  return [...modeWeakening, ...weakerSettings(resolved, ''), ...scoped];
}

const MODES = new Set(['off', 'basic', 'standard', 'strict', 'recommended', 'all']);

/** A file-level `# pyright:` comment's directive that loosens the file, with its 1-based line. */
export type WeakerComment = { readonly line: number; readonly directive: string };

function loosens(part: string): boolean {
  const [key = '', value] = part.split('=').map((piece) => piece.trim());
  if (value === undefined) return MODES.has(key) && key !== 'all';
  const parsed = value === 'true' || value === 'false' ? value === 'true' : value;
  return weakening(key, parsed) !== undefined;
}

/**
 * File-level `# pyright:` comments that loosen a file: a mode other than "all", or a rule set
 * below an error. basedpyright honours them over any config file. `# pyright: ignore[...]` is a
 * suppression on its line, not a file setting.
 */
export function weakerComments(text: string): WeakerComment[] {
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const directive = /^#\s*pyright:(.*)$/.exec(raw.trim())?.[1]?.trim();
    if (directive === undefined || directive === '' || /^ignore\b/.test(directive)) return [];
    return directive.split(',').some((part) => loosens(part))
      ? [{ line: index + 1, directive }]
      : [];
  });
}

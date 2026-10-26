import { LUACHECK_PROJECT, luaFiles, TREE } from './paths.js';
import { generatedHeader, generatedJsonNote } from '../../configs/header.js';
import type { ApplyContext } from '../../core/check.js';
import type { Generated } from '../../core/pack.js';

export const STYLUA_CONFIG = 'stylua.toml';
export const LUACHECK_BASE = '.luacheckrc';
const LUARC = '.luarc.json';

/** The project file's module name: luacheck requires it relative to `.luacheckrc`. */
const PROJECT_MODULE = LUACHECK_PROJECT.replace(/\.lua$/, '');

/**
 * StyLua's defaults written out, so neither an `.editorconfig` nor a newer StyLua's defaults
 * move them; indentation is spaces, as in every SVP-Labs Lua project. Formatting is not a
 * project's choice, so there is no extension file.
 */
const STYLUA_OPTIONS: readonly (readonly [string, string])[] = [
  ['syntax', '"Lua54"'],
  ['column_width', '120'],
  ['line_endings', '"Unix"'],
  ['indent_type', '"Spaces"'],
  ['indent_width', '4'],
  ['quote_style', '"AutoPreferDouble"'],
  ['call_parentheses', '"Always"'],
  ['collapse_simple_statement', '"Never"'],
  ['space_after_function_names', '"Never"'],
];

/** Directories editors running luacheck on `.` should skip: the installed rocks. */
const LUACHECK_EXCLUDES = [`${TREE}/`, '.luarocks/', 'lua_modules/'];

/**
 * What the base sets, which the project's file may only tighten. Line lengths match StyLua's
 * column width, except that a line ending inside a string has none, as ESLint ignores strings;
 * the whitespace and indentation warnings are StyLua's to fix, so they're off.
 */
export const LUACHECK_OPTIONS = {
  std: 'lua54',
  maxLineLength: 120,
  maxCyclomaticComplexity: 12,
  ignore: ['611', '612', '614', '621'],
  excludeFiles: LUACHECK_EXCLUDES,
} as const;

function luaList(items: readonly string[]): string {
  return `{ ${items.map((item) => JSON.stringify(item)).join(', ')} }`;
}

export function renderStylua(version: string): string {
  const options = STYLUA_OPTIONS.map(([key, value]) => `${key} = ${value}`);
  return [
    generatedHeader('#', version).trimEnd(),
    ...options,
    '',
    '[sort_requires]',
    'enabled = false',
    '',
  ].join('\n');
}

/**
 * luacheck's base, which ends by returning the project's settings when it has the file, and
 * luacheck lets what a config returns override what it set.
 */
export function renderLuacheck(version: string): string {
  const options = LUACHECK_OPTIONS;
  const missing = `module '${PROJECT_MODULE}' not found`;
  return [
    generatedHeader('--', version, LUACHECK_PROJECT).trimEnd(),
    `std = ${JSON.stringify(options.std)}`,
    `max_line_length = ${options.maxLineLength}`,
    `max_code_line_length = ${options.maxLineLength}`,
    '-- A long string is the text it holds; StyLua leaves it as it is.',
    'max_string_line_length = false',
    `max_comment_line_length = ${options.maxLineLength}`,
    `max_cyclomatic_complexity = ${options.maxCyclomaticComplexity}`,
    "-- Trailing whitespace and indentation are StyLua's to fix.",
    `ignore = ${luaList(options.ignore)}`,
    `exclude_files = ${luaList(options.excludeFiles)}`,
    '',
    `local found, project = pcall(require, ${JSON.stringify(PROJECT_MODULE)})`,
    'if found then',
    '    return project',
    `elseif not tostring(project):find(${JSON.stringify(missing)}, 1, true) then`,
    '    error(project, 0)',
    'end',
    '',
  ].join('\n');
}

/**
 * The diagnostics luacheck already reports (unused code, globals, shadowing, unbalanced
 * assignments, empty blocks, unreachable code) and StyLua already fixes (trailing spaces).
 */
export const LUALS_DISABLED = [
  'code-after-break',
  'count-down-loop',
  'empty-block',
  'global-element',
  'lowercase-global',
  'redefined-local',
  'redundant-value',
  'trailing-space',
  'unbalanced-assignments',
  'undefined-global',
  'unreachable-code',
  'unused-function',
  'unused-label',
  'unused-local',
  'unused-vararg',
];

/** Every diagnostic group LuaLS has, on for every file; code style is StyLua's and cspell's. */
const LUALS_GROUPS = [
  'ambiguity',
  'await',
  'conventions',
  'duplicate',
  'global',
  'luadoc',
  'redefined',
  'strict',
  'strong',
  'type-check',
  'unbalanced',
  'unused',
];

/** LuaLS's settings; it reads no other file alongside, so this one has no extension. */
export function luarcSettings(): Record<string, unknown> {
  return {
    'runtime.version': 'Lua 5.4',
    'runtime.pathStrict': false,
    'diagnostics.groupFileStatus': {
      ...Object.fromEntries(LUALS_GROUPS.map((group) => [group, 'Any'])),
      codestyle: 'None',
    },
    'diagnostics.disable': LUALS_DISABLED,
    'type.castNumberToInteger': false,
    'type.weakUnionCheck': false,
    'type.weakNilCheck': false,
    'type.checkTableShape': true,
    'workspace.checkThirdParty': false,
    'workspace.ignoreDir': [TREE],
    'workspace.library': [
      `${TREE}/share/lua/5.4`,
      '${3rd}/busted/library',
      '${3rd}/luassert/library',
    ],
  };
}

export function renderLuarc(version: string): string {
  const settings = { '//': generatedJsonNote(version), ...luarcSettings() };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

const hasLua = (ctx: ApplyContext): boolean => luaFiles(ctx).length > 0;

const styluaBase: Generated = {
  path: STYLUA_CONFIG,
  scope: 'component',
  langs: ['lua'],
  applies: hasLua,
  render: (ctx) => renderStylua(ctx.version),
};

const luacheckBase: Generated = {
  path: LUACHECK_BASE,
  scope: 'component',
  langs: ['lua'],
  applies: hasLua,
  render: (ctx) => renderLuacheck(ctx.version),
  extension: {
    path: LUACHECK_PROJECT,
    initial: () =>
      `-- This project's additions to ${LUACHECK_BASE}, which may only tighten it.\n` +
      '-- Declare the globals the host provides here, such as read_globals = { "love" }.\n' +
      'return {}\n',
  },
};

const luarcBase: Generated = {
  path: LUARC,
  scope: 'component',
  langs: ['lua'],
  applies: hasLua,
  render: (ctx) => renderLuarc(ctx.version),
};

export const LUA_GENERATED: readonly Generated[] = [styluaBase, luacheckBase, luarcBase];

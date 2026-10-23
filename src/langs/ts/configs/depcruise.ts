import { excludes } from './shared.js';
import { generatedHeader } from '../../../configs/header.js';
import type { RenderContext } from '../../../core/pack.js';

export const DEPCRUISE_BASE = '.dependency-cruiser.cjs';
export const DEPCRUISE_PROJECT = '.dependency-cruiser.project.cjs';

/** The rules every project keeps, by name; the config-strength check looks for each. */
export const UNIVERSAL_RULES = [
  'no-circular',
  'no-test-code-in-shipped-code',
  'no-dev-deps-in-shipped-code',
  'no-unresolvable',
] as const;

const TEST = String.raw`(^|/)(tests?|e2e|testing|__tests__)/|\.(test|spec)\.[cm]?[jt]sx?$`;
const NOT_SHIPPED = String.raw`${TEST}|(^|/)scripts/|(^|/)([^/]*\.(config|project)\.[cm]?[jt]s|\.[^/]+\.[cm]?js)$`;

/** Build output, but never inside node_modules: a package's own dist is still a dependency. */
const BUILD_OUTPUT = String.raw`^(?!.*node_modules/)(?:dist|coverage|\.stryker-tmp|.*/dist|.*/coverage)/`;

function escapeRegex(text: string): string {
  return text.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
}

/** An `exclude` entry (a path or a glob) as an anchored regular expression. */
export function excludeRegex(entry: string): string {
  const body = escapeRegex(entry)
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll('\0', '.*');
  return `^${body}(/|$)`;
}

export function renderDepcruise(ctx: RenderContext): string {
  const exclude = [BUILD_OUTPUT, ...excludes(ctx).map((entry) => excludeRegex(entry))].join('|');
  return `${generatedHeader('//', ctx.version, DEPCRUISE_PROJECT)}/**
 * The universal rules: no import cycles, and shipped code imports no test code and no dev-only
 * dependency. Tests, scripts and tool configs are not shipped. The project's own rules, in
 * dependency-cruiser's syntax, come from ${DEPCRUISE_PROJECT}.
 */
const project = require('./${DEPCRUISE_PROJECT}');

const TEST = String.raw\`${TEST}\`;
const NOT_SHIPPED = String.raw\`${NOT_SHIPPED}\`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  ...project,
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-test-code-in-shipped-code',
      severity: 'error',
      from: { pathNot: NOT_SHIPPED },
      to: { path: TEST },
    },
    {
      name: 'no-dev-deps-in-shipped-code',
      severity: 'error',
      from: { pathNot: NOT_SHIPPED },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    ...(project.forbidden ?? []),
  ],
  options: {
    ...(project.options ?? {}),
    doNotFollow: { path: 'node_modules' },
    exclude: { path: String.raw\`${exclude}\` },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
`;
}

export function depcruiseProjectInitial(): string {
  return `/**
 * The project's architecture rules, in dependency-cruiser's syntax; the generated base
 * (${DEPCRUISE_BASE}) adds the universal ones.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [],
};
`;
}

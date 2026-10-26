import { join } from 'node:path';
import { type NeonMap, toNeon } from './neon.js';
import { componentDir, fileExists, type Place } from './paths.js';
import { notInstalled } from './run.js';
import { generatedHeader } from '../../configs/header.js';

export const PHPSTAN_BASE = 'phpstan.neon';
export const PHPSTAN_PROJECT = 'phpstan.project.neon';

/** A PHPStan extension: the package that installs it and its config, under `vendor/`. */
export type Extension = { readonly pkg: string; readonly file: string };

/** The extensions every PHP component's analysis includes, in this order. */
const EXTENSIONS: readonly Extension[] = [
  { pkg: 'phpstan/phpstan-strict-rules', file: 'phpstan/phpstan-strict-rules/rules.neon' },
  {
    pkg: 'tomasvotruba/cognitive-complexity',
    file: 'tomasvotruba/cognitive-complexity/config/extension.neon',
  },
  { pkg: 'shipmonk/dead-code-detector', file: 'shipmonk/dead-code-detector/rules.neon' },
  { pkg: 'pestphp/pest-plugin-phpstan', file: 'pestphp/pest-plugin-phpstan/extension.neon' },
];

/** Laravel's rules, for a component that is a Laravel application. */
const LARASTAN: Extension = {
  pkg: 'larastan/larastan',
  file: 'larastan/larastan/extension.neon',
};

export const TYPE_COVERAGE: Extension = {
  pkg: 'tomasvotruba/type-coverage',
  file: 'tomasvotruba/type-coverage/config/extension.neon',
};

/**
 * Level max, every stricter-analysis switch PHPStan has turned the strict way, strict-rules in
 * full, and the limits. Checked exceptions stay off: TypeScript, which sets the bar, has none.
 */
export const PHPSTAN_PARAMETERS: NeonMap = {
  level: 'max',
  checkBenevolentUnionTypes: true,
  checkDynamicProperties: true,
  checkExplicitMixedMissingReturn: true,
  checkFunctionNameCase: true,
  checkImplicitMixed: true,
  checkInternalClassCaseSensitivity: true,
  checkMissingCallableSignature: true,
  checkMissingOverrideMethodAttribute: true,
  checkStrictPrintfPlaceholderTypes: true,
  checkTooWideParameterOutInProtectedAndPublicMethods: true,
  checkTooWideReturnTypesInProtectedAndPublicMethods: true,
  checkTooWideThrowTypesInProtectedAndPublicMethods: true,
  checkUninitializedProperties: true,
  inferPrivatePropertyTypeFromConstructor: false,
  polluteScopeWithAlwaysIterableForeach: false,
  polluteScopeWithBlock: false,
  polluteScopeWithLoopInitialAssignments: false,
  rememberPossiblyImpureFunctionValues: false,
  reportAlwaysTrueInLastCondition: true,
  reportAnyTypeWideningInVarTag: true,
  reportIgnoresWithoutComments: true,
  reportMaybesInMethodSignatures: true,
  reportMaybesInPropertyPhpDocTypes: true,
  reportNonIntStringArrayKey: true,
  reportPossiblyNonexistentConstantArrayOffset: true,
  reportPossiblyNonexistentGeneralArrayOffset: true,
  reportStaticMethodSignatures: true,
  reportUnmatchedIgnoredErrors: true,
  reportWrongPhpDocTypeInVarTag: true,
  treatPhpDocTypesAsCertain: true,
  strictRules: { allRules: true },
  cognitive_complexity: { function: 15 },
  shipmonkDeadCode: { reportTransitivelyDeadMethodAsSeparateError: true },
};

/** The extensions a component's analysis includes: Larastan only in a Laravel application. */
export function extensionsFor(laravel: boolean): Extension[] {
  return laravel ? [...EXTENSIONS, LARASTAN] : [...EXTENSIONS];
}

/** The committed base: vendor paths relative to it, and the project's extension last. */
export function renderPhpstanBase(version: string, laravel: boolean): string {
  const includes = [
    ...extensionsFor(laravel).map((extension) => `vendor/${extension.file}`),
    PHPSTAN_PROJECT,
  ];
  return (
    generatedHeader('#', version, PHPSTAN_PROJECT) +
    toNeon({ includes, parameters: PHPSTAN_PARAMETERS })
  );
}

export type GateOptions = {
  readonly laravel: boolean;
  /** Packages phpstan/extension-installer already includes, which PHPStan refuses twice. */
  readonly installed: ReadonlySet<string>;
  /** Extensions this run adds after the base's (type coverage). */
  readonly extra?: readonly Extension[];
  /** Includes the project's extension file, when there is one. */
  readonly project: boolean;
};

/**
 * The base as the gate runs it, from a scratch directory: absolute includes, each extension
 * checked to be installed, and the project's file only when it exists.
 */
export async function gateIncludes(
  place: Pick<Place, 'root' | 'component'>,
  options: GateOptions,
): Promise<string[]> {
  const dir = componentDir(place);
  const extensions = [...extensionsFor(options.laravel), ...(options.extra ?? [])];
  const includes: string[] = [];
  for (const extension of extensions) {
    const file = join(dir, 'vendor', ...extension.file.split('/'));
    if (!(await fileExists(file))) throw notInstalled(place, extension.pkg);
    if (!options.installed.has(extension.pkg)) includes.push(file);
  }
  const project = join(dir, PHPSTAN_PROJECT);
  if (options.project && (await fileExists(project))) includes.push(project);
  return includes;
}

import { isLaravel, readInstalled, readManifest } from './composer.js';
import type { Bound } from './run.js';
import type { Finding } from '../../core/finding.js';
import type { DevTools } from '../../core/pack.js';

/**
 * The tools a PHP project pins in `require-dev`, at exactly these versions: every program the
 * checks run and every PHPStan extension the base includes. Pest 5, and so its PHPStan plugin,
 * needs PHP 8.4 or later.
 */
export const PHP_DEV_TOOLS: DevTools = {
  manager: 'composer',
  packages: {
    'deptrac/deptrac': '4.7.2',
    'infection/infection': '0.35.8',
    'larastan/larastan': '3.13.1',
    'laravel/pint': '1.32.1',
    'pestphp/pest': '5.3.3',
    'pestphp/pest-plugin-phpstan': '5.2.2',
    'phpmd/phpmd': '3.0.0',
    'phpstan/phpstan': '2.3.1',
    'phpstan/phpstan-strict-rules': '2.1.0',
    'shipmonk/dead-code-detector': '1.4.2',
    'tomasvotruba/cognitive-complexity': '1.3.0',
    'tomasvotruba/type-coverage': '2.5.1',
  },
};

/** Larastan needs the framework, so only a project that requires laravel/framework pins it. */
const LARAVEL_ONLY: ReadonlySet<string> = new Set(['larastan/larastan']);

/** The pins that apply to a component: Larastan's only in a Laravel project. */
export function pinsFor(laravel: boolean): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(PHP_DEV_TOOLS.packages).filter(([name]) => laravel || !LARAVEL_ONLY.has(name)),
  );
}

/**
 * Each pinned tool against the version Composer installed from the lockfile. A tool at another
 * version makes the editor and the gate disagree.
 */
export function toolchainFindings(
  pins: Readonly<Record<string, string>>,
  installed: ReadonlyMap<string, string>,
): Finding[] {
  return Object.entries(pins)
    .filter(([name, pinned]) => installed.get(name) !== pinned)
    .map(([name, pinned]) => drift(name, pinned, installed.get(name)));
}

function drift(name: string, pinned: string, found: string | undefined): Finding {
  const key = `composer ${name}`;
  if (found === undefined) {
    return {
      key,
      rule: 'toolchain/missing',
      message: `${name} is not in require-dev; Talos runs ${name} ${pinned}.`,
    };
  }
  return {
    key,
    rule: 'toolchain/mismatch',
    message: `${name} ${found} is installed but Talos runs ${pinned}, so the editor and the gate may disagree.`,
  };
}

/**
 * Packages that can't be installed beside the pinned tools. phpstan/extension-installer includes
 * every installed extension in PHPStan's config on its own, and PHPStan refuses a file included
 * twice, so the committed phpstan.neon, which includes them itself, fails in editors.
 */
const CONFLICTS: Readonly<Record<string, string>> = {
  'phpstan/extension-installer':
    'phpstan/extension-installer includes the PHPStan extensions phpstan.neon already includes, ' +
    'and PHPStan refuses a file included twice; remove it from require-dev.',
};

export function conflictFindings(installed: ReadonlyMap<string, string>): Finding[] {
  return Object.entries(CONFLICTS)
    .filter(([name]) => installed.has(name))
    .map(([name, message]) => ({ rule: 'toolchain/conflict', message, key: `composer ${name}` }));
}

export async function toolchain(ctx: Bound): Promise<Finding[]> {
  const pins = pinsFor(isLaravel(await readManifest(ctx)));
  const installed = await readInstalled(ctx);
  return [...toolchainFindings(pins, installed), ...conflictFindings(installed)];
}

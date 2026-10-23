import semver from 'semver';
import { z } from 'zod';
import type { Manifest } from './dev-deps.js';

/**
 * `composer.json` as the PHP tools need it, beyond the pinned versions: Pest's and Infection's
 * Composer plugins allowed to run, no `phpstan/extension-installer` (it would include the PHPStan
 * extensions the base already includes, and PHPStan refuses a file included twice), and PHP 8.4
 * or later, which Pest 5 and its PHPStan plugin need.
 */

const PLUGINS = ['pestphp/pest-plugin', 'infection/extension-installer'];
const INSTALLER = 'phpstan/extension-installer';
const PHP = '^8.4';

const table = z.record(z.string(), z.unknown());
const constraints = z.record(z.string(), z.string());

export function isLaravel(manifest: Manifest): boolean {
  return ['require', 'require-dev'].some(
    (field) => 'laravel/framework' in constraints.catch({}).parse(manifest[field] ?? {}),
  );
}

/**
 * Whether a Composer constraint lets in a PHP older than 8.4. One that can't be read is left as
 * it is: `undefined`.
 */
export function allowsOlderPhp(constraint: string): boolean | undefined {
  const range = constraint
    .split(',')
    .map((part) => part.trim())
    .join(' ')
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' || ');
  try {
    const lowest = semver.minVersion(range);
    return lowest === null ? undefined : semver.lt(lowest, '8.4.0');
  } catch {
    return undefined;
  }
}

function withoutInstaller(manifest: Manifest, field: string): Manifest {
  const listed = table.catch({}).parse(manifest[field] ?? {});
  if (!(INSTALLER in listed)) return manifest;
  const { [INSTALLER]: _, ...rest } = listed;
  return { ...manifest, [field]: rest };
}

function withPlugins(manifest: Manifest): Manifest {
  const config = table.catch({}).parse(manifest.config ?? {});
  const allowed = config['allow-plugins'];
  if (allowed === true) return manifest;
  const plugins = table.catch({}).parse(allowed ?? {});
  const { [INSTALLER]: _, ...kept } = plugins;
  const next = { ...kept, ...Object.fromEntries(PLUGINS.map((name) => [name, true])) };
  const same = !(INSTALLER in plugins) && PLUGINS.every((name) => plugins[name] === true);
  return same ? manifest : { ...manifest, config: { ...config, 'allow-plugins': next } };
}

function withPhp(manifest: Manifest): Manifest {
  const require = constraints.catch({}).parse(manifest.require ?? {});
  const php = require.php;
  if (php !== undefined && allowsOlderPhp(php) !== true) return manifest;
  return { ...manifest, require: { ...table.catch({}).parse(manifest.require ?? {}), php: PHP } };
}

/** The manifest with the plugins, the PHP version and no extension installer. */
export function composerSettings(manifest: Manifest): Manifest {
  return withPhp(
    withPlugins(withoutInstaller(withoutInstaller(manifest, 'require-dev'), 'require')),
  );
}

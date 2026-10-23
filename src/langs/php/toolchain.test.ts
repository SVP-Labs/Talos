import { describe, expect, it } from 'vitest';
import { isLaravel, parseInstalled, parseManifest } from './composer.js';
import { conflictFindings, PHP_DEV_TOOLS, pinsFor, toolchainFindings } from './toolchain.js';
import { EngineError } from '../../core/check.js';

// Trimmed from vendor/composer/installed.json as Composer 2.8 writes it.
const INSTALLED = `{"packages":[
 {"name":"laravel/pint","version":"v1.32.0","version_normalized":"1.32.0.0"},
 {"name":"phpstan/phpstan","version":"2.3.1","version_normalized":"2.3.1.0"}],
 "dev":true,"dev-package-names":["laravel/pint","phpstan/phpstan"]}`;

describe('parseInstalled', () => {
  it('reads installed versions without the tag prefix, in either layout Composer wrote', () => {
    expect(parseInstalled(INSTALLED)).toEqual(
      new Map([
        ['laravel/pint', '1.32.0'],
        ['phpstan/phpstan', '2.3.1'],
      ]),
    );
    expect(parseInstalled('[{"name":"a/b","version":"v1.0.0"}]')).toEqual(
      new Map([['a/b', '1.0.0']]),
    );
    expect(() => parseInstalled('{')).toThrow(EngineError);
  });
});

describe('isLaravel', () => {
  it('knows a project that requires the framework', () => {
    expect(isLaravel(parseManifest('{"require":{"laravel/framework":"^12"}}'))).toBe(true);
    expect(isLaravel(parseManifest('{"require-dev":{"laravel/framework":"^12"}}'))).toBe(true);
    expect(isLaravel(parseManifest('{"require":{"php":"^8.4"}}'))).toBe(false);
  });
});

describe('toolchainFindings', () => {
  it('pins Larastan only in a Laravel project', () => {
    expect(Object.keys(pinsFor(false))).not.toContain('larastan/larastan');
    expect(Object.keys(pinsFor(true))).toContain('larastan/larastan');
    expect(PHP_DEV_TOOLS.manager).toBe('composer');
  });

  it('reports each tool missing or at another version, keyed by package', () => {
    const pins = { 'laravel/pint': '1.32.1', 'phpstan/phpstan': '2.3.1', 'phpmd/phpmd': '3.0.0' };
    expect(toolchainFindings(pins, parseInstalled(INSTALLED))).toEqual([
      {
        rule: 'toolchain/mismatch',
        message:
          'laravel/pint 1.32.0 is installed but Talos runs 1.32.1, so the editor and the gate may disagree.',
        key: 'composer laravel/pint',
      },
      {
        rule: 'toolchain/missing',
        message: 'phpmd/phpmd is not in require-dev; Talos runs phpmd/phpmd 3.0.0.',
        key: 'composer phpmd/phpmd',
      },
    ]);
  });
});

describe('conflictFindings', () => {
  it('reports phpstan/extension-installer, which makes PHPStan refuse the base', () => {
    const installed = new Map([['phpstan/extension-installer', '1.4.3']]);
    expect(conflictFindings(installed)).toMatchObject([
      { rule: 'toolchain/conflict', key: 'composer phpstan/extension-installer' },
    ]);
    expect(conflictFindings(new Map())).toEqual([]);
  });
});

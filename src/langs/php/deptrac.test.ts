import { describe, expect, it } from 'vitest';
import { parseLock } from './composer.js';
import {
  classmapClasses,
  commonNamespace,
  deptracConfig,
  devPrefixes,
  escapePcre,
  testPattern,
} from './deptrac-config.js';
import { parseDeptracJson, universalFinding } from './deptrac.js';
import { EngineError } from '../../core/check.js';

// Recorded from deptrac 4.7.2 (`--formatter=json`).
const REPORT = `{"Report":{"Violations":2,"Skipped violations":0,"Uncovered":1,"Allowed":0,
"Warnings":0,"Errors":0},"files":{"\\/repo\\/src\\/Report.php":{"messages":[
{"message":"Ledger\\\\Report must not depend on PhpParser\\\\ParserFactory (Shipped on DevDependencies)","line":14,"type":"error"},
{"message":"Ledger\\\\Report must not depend on Tests\\\\Support\\\\Fixture (Shipped on Tests)","line":16,"type":"error"}],
"violations":2}}}`;

const CLEAN = `{"Report":{"Violations":0,"Skipped violations":0,"Uncovered":0,"Allowed":0,"Warnings":0,
"Errors":0},"files":[]}`;

const toRepo = (file: string): string => file.replace('/repo/', '');

describe('parseDeptracJson', () => {
  it('reads every violation and the count of config errors', () => {
    const { violations: found, errors } = parseDeptracJson(JSON.parse(REPORT));
    expect(errors).toBe(0);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      file: '/repo/src/Report.php',
      line: 14,
      message:
        'Ledger\\Report must not depend on PhpParser\\ParserFactory (Shipped on DevDependencies)',
    });
    expect(parseDeptracJson(JSON.parse(CLEAN))).toEqual({ violations: [], errors: 0 });
    expect(parseDeptracJson({ Report: { Errors: 2 }, files: [] }).errors).toBe(2);
  });

  it('refuses a shape it does not know', () => {
    expect(() => parseDeptracJson({ files: {} })).toThrow(EngineError);
  });
});

describe('universalFinding', () => {
  it('names the universal rule a violation breaks', () => {
    const [dev, test] = parseDeptracJson(JSON.parse(REPORT)).violations;
    expect(dev && universalFinding(dev, toRepo)).toEqual({
      rule: 'deptrac/dev-dependency',
      message:
        'Shipped code must not use a package only require-dev installs: Ledger\\Report uses ' +
        'PhpParser\\ParserFactory.',
      location: { file: 'src/Report.php', line: 14 },
    });
    expect(test && universalFinding(test, toRepo).rule).toBe('deptrac/test-code');
    const own = { file: '/repo/src/A.php', line: 3, message: 'A must not depend on B (X on Y)' };
    expect(universalFinding(own, toRepo)).toMatchObject({
      rule: 'deptrac/layers',
      message: 'A must not depend on B (X on Y).',
    });
  });
});

describe('the universal config', () => {
  it('escapes for PCRE between # delimiters', () => {
    expect(escapePcre('Foo\\Bar\\')).toBe('Foo\\\\Bar\\\\');
    expect(escapePcre('/a.b#c')).toBe('\\/a\\.b\\#c');
  });

  it('matches test code by path, exactly', () => {
    const pattern = new RegExp(testPattern().replace('(?-i)', ''));
    expect(pattern.test('/x/tests/Unit/AThing.php')).toBe(true);
    expect(pattern.test('/x/src/FooTest.php')).toBe(true);
    expect(pattern.test('/x/src/Latest.php')).toBe(false);
    expect(testPattern('/repo/app')).toBe(String.raw`(?-i)^\/repo\/app/(.*/)?tests?/|Test\.php$`);
  });

  it('forbids shipped code test code, and dev-only packages when it knows them', () => {
    const config = deptracConfig({
      paths: ['/repo/src'],
      excludeFiles: [],
      tests: testPattern(),
      devPrefixes: ['PHPUnit\\', 'Pest\\'],
    });
    expect(config).toMatchObject({
      deptrac: {
        layers: [
          { name: 'Tests' },
          { name: 'Shipped' },
          {
            name: 'DevDependencies',
            collectors: [{ type: 'classNameRegex', value: '#^(?:PHPUnit\\\\|Pest\\\\)#' }],
          },
        ],
        ruleset: { Tests: ['Shipped', 'DevDependencies'] },
      },
    });
    const base = deptracConfig({ paths: ['.'], excludeFiles: [], tests: testPattern() });
    expect(base).toMatchObject({ deptrac: { ruleset: { Tests: ['Shipped'] } } });
  });
});

describe('dev-only packages', () => {
  // Trimmed from vendor/composer/autoload_classmap.php as Composer 2.8 writes it.
  const CLASSMAP = [
    '<?php',
    '',
    'return array(',
    "    'Composer\\\\InstalledVersions' => $vendorDir . '/composer/InstalledVersions.php',",
    "    'PHPUnit\\\\Framework\\\\Assert' => $vendorDir . '/phpunit/phpunit/src/Framework/Assert.php',",
    "    'PHPUnit\\\\Runner\\\\Version' => $vendorDir . '/phpunit/phpunit/src/Runner/Version.php',",
    "    'App\\\\Kernel' => $baseDir . '/app/Kernel.php',",
    ');',
  ].join('\n');

  it('reads the classes each package maps', () => {
    expect(classmapClasses(CLASSMAP)).toEqual(
      new Map([['phpunit/phpunit', ['PHPUnit\\Framework\\Assert', 'PHPUnit\\Runner\\Version']]]),
    );
  });

  it('finds the namespace classes share', () => {
    expect(commonNamespace(['PHPUnit\\Framework\\Assert', 'PHPUnit\\Runner\\Version'])).toBe(
      'PHPUnit\\',
    );
    expect(commonNamespace(['A\\B\\C', 'A\\B\\D'])).toBe('A\\B\\');
    expect(commonNamespace(['Global', 'A\\B'])).toBeUndefined();
    expect(commonNamespace([])).toBeUndefined();
  });

  it('names the prefixes of packages-dev, but none the project or its packages use', () => {
    const lock = parseLock(
      JSON.stringify({
        packages: [
          { name: 'psr/log', version: '3.0.2', autoload: { 'psr-4': { 'Psr\\Log\\': 'src' } } },
        ],
        'packages-dev': [
          { name: 'pestphp/pest', version: 'v5.3.3', autoload: { 'psr-4': { 'Pest\\': 'src/' } } },
          { name: 'phpunit/phpunit', version: '13.4.3', autoload: { classmap: ['src/'] } },
          { name: 'odd/fallback', version: '1.0.0', autoload: { 'psr-4': { '': 'src/' } } },
          {
            name: 'laravel/pint',
            version: 'v1.32.1',
            autoload: { 'psr-4': { 'App\\': 'app/', 'Database\\Seeders\\': 'database/seeders/' } },
          },
          { name: 'odd/logging', version: '1.0.0', autoload: { 'psr-4': { 'Psr\\': 'src/' } } },
        ],
      }),
    );
    const own = ['App\\', 'Database\\Seeders\\', 'Tests\\'];
    expect(devPrefixes(lock, classmapClasses(CLASSMAP), own)).toEqual(['Pest\\', 'PHPUnit\\']);
  });
});

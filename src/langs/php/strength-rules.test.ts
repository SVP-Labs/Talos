import { describe, expect, it } from 'vitest';
import { phpmdExcludes, phpunitExcludes, weakerPhpstan } from './strength-rules.js';

// Trimmed from `phpstan dump-parameters --json` (PHPStan 2.3.1) for the base, then with an
// extension that loosens it.
const BASE = {
  level: 'max',
  checkUninitializedProperties: true,
  reportPossiblyNonexistentGeneralArrayOffset: true,
  strictRules: { allRules: true, disallowedLooseComparison: true, booleansInConditions: true },
  cognitive_complexity: { class: 50, function: 15 },
  shipmonkDeadCode: {
    detect: { deadMethods: true, deadProperties: { neverRead: true, neverWritten: true } },
  },
  ignoreErrors: [],
  excludePaths: { analyseAndScan: [], analyse: [] },
  universalObjectCratesClasses: ['stdClass', 'PHPUnit\\Framework\\TestCase'],
  dynamicConstantNames: ['ICONV_IMPL'],
};

const EFFECTIVE = {
  ...BASE,
  strictRules: { ...BASE.strictRules, disallowedLooseComparison: false },
  cognitive_complexity: { class: 80, function: 15 },
  shipmonkDeadCode: {
    detect: { deadMethods: true, deadProperties: { neverRead: false, neverWritten: true } },
  },
  ignoreErrors: [{ identifier: 'missingType.iterableValue' }],
  excludePaths: { analyseAndScan: [], analyse: ['/repo/src/Legacy'] },
  universalObjectCratesClasses: [...BASE.universalObjectCratesClasses, 'App\\Bag'],
};

describe('weakerPhpstan', () => {
  it('reports a switch turned, a limit raised and every entry added to a list that lets errors through', () => {
    expect(weakerPhpstan(BASE, EFFECTIVE)).toEqual([
      {
        setting: 'strictRules.disallowedLooseComparison',
        message: 'sets strictRules.disallowedLooseComparison to false',
      },
      {
        setting: 'shipmonkDeadCode.detect.deadProperties.neverRead',
        message: 'sets shipmonkDeadCode.detect.deadProperties.neverRead to false',
      },
      { setting: 'cognitive_complexity.class', message: 'raises cognitive_complexity.class to 80' },
      {
        setting: 'ignoreErrors {"identifier":"missingType.iterableValue"}',
        message: 'ignores errors matching {"identifier":"missingType.iterableValue"}',
      },
      {
        setting: 'excludePaths.analyse /repo/src/Legacy',
        message: 'leaves "/repo/src/Legacy" out of the analysis',
      },
      {
        setting: 'universalObjectCratesClasses App\\Bag',
        message: 'lets "App\\Bag" take any property',
      },
    ]);
  });

  it('finds nothing in a base alone', () => {
    expect(weakerPhpstan(BASE, BASE)).toEqual([]);
  });
});

describe('phpmdExcludes', () => {
  it('reports each exclude-pattern on its line', () => {
    const xml =
      '<ruleset name="P">\n    <exclude-pattern>*/Legacy/*</exclude-pattern>\n</ruleset>\n';
    expect(phpmdExcludes(xml)).toEqual([
      {
        line: 2,
        message:
          'This exclude-pattern leaves files matching "*/Legacy/*" out of PHPMD, which is weaker than phpmd.xml.',
      },
    ]);
  });
});

describe('phpunitExcludes', () => {
  it("reports each exclude inside <source>, and none of a test suite's", () => {
    const xml = [
      '<phpunit>',
      '  <testsuites><testsuite name="T"><directory>tests</directory>',
      '    <exclude>tests/Slow</exclude></testsuite></testsuites>',
      '  <source>',
      '    <include><directory>src</directory></include>',
      '    <exclude>',
      '      <directory>src/Legacy</directory>',
      '    </exclude>',
      '  </source>',
      '</phpunit>',
    ].join('\n');
    expect(phpunitExcludes(xml).map((l) => l.line)).toEqual([6]);
  });
});

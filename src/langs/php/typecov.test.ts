import { describe, expect, it } from 'vitest';
import { atFloor, typecovFindings, untypedFrom } from './typecov.js';
import { EngineError } from '../../core/check.js';

// Recorded from tomasvotruba/type-coverage 2.5.1 under PHPStan 2.3.1, levels set to 100.
const message = (kind: string, total: number, typed: number): string =>
  `Out of ${total} possible ${kind} types, only ${typed} - ${((typed * 100) / total).toFixed(1)} ` +
  `% actually have it. Add more ${kind} types to get over 100 %`;

const REPORT = {
  messages: [
    {
      file: '/repo/src/Calculator.php',
      line: 16,
      identifier: 'typeCoverage.paramTypeCoverage',
      message: message('param', 11, 9),
    },
    {
      file: '/repo/src/Calculator.php',
      line: 53,
      identifier: 'typeCoverage.propertyTypeCoverage',
      message: message('property', 400, 399),
    },
    {
      file: '/repo/src/Calculator.php',
      line: 3,
      identifier: 'class.notFound',
      message: 'Class X not found.',
    },
  ],
  general: [],
};

describe('untypedFrom', () => {
  it("reads each untyped declaration with its kind's totals, ignoring other errors", () => {
    expect(untypedFrom(REPORT)).toEqual([
      { kind: 'param', file: '/repo/src/Calculator.php', line: 16, total: 11, typed: 9 },
      { kind: 'property', file: '/repo/src/Calculator.php', line: 53, total: 400, typed: 399 },
    ]);
  });

  it('refuses a run with an internal error, which skips the measurement', () => {
    expect(() => untypedFrom({ messages: [], general: ['Internal error'] })).toThrow(EngineError);
  });

  it('refuses a message whose counts it cannot read', () => {
    const odd = {
      messages: [
        { file: '/a.php', line: 1, identifier: 'typeCoverage.paramTypeCoverage', message: 'Hm' },
      ],
      general: [],
    };
    expect(() => untypedFrom(odd)).toThrow(EngineError);
  });
});

describe('typecovFindings', () => {
  it('blocks under the 99.5% floor and informs at or above it', () => {
    expect(atFloor({ total: 200, typed: 199 })).toBe(true);
    expect(atFloor({ total: 1000, typed: 994 })).toBe(false);
    const found = typecovFindings(untypedFrom(REPORT), (file) => file.replace('/repo/', ''));
    expect(found).toEqual([
      {
        rule: 'typecov/param',
        message:
          'This parameter has no type; 9 of 11 parameters in shipped code are typed (81.8%), ' +
          'under the 99.5% floor.',
        location: { file: 'src/Calculator.php', line: 16 },
      },
      {
        rule: 'typecov/property',
        message:
          'This property has no type; 399 of 400 properties in shipped code are typed ' +
          '(99.8%), at or above the 99.5% floor.',
        location: { file: 'src/Calculator.php', line: 53 },
        policy: 'info',
      },
    ]);
  });
});

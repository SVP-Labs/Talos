import { describe, expect, it } from 'vitest';
import { parsePhpmdJson } from './phpmd.js';
import { EngineError } from '../../core/check.js';

// Recorded from PHPMD 3.0.0 (`analyze --format=json`), trimmed.
const REPORT = `{"version":"3.0.0","package":"phpmd","timestamp":"2026-10-23T12:42:59+00:00","files":[
{"file":"/repo/src/Calculator.php","relativePath":"src/Calculator.php","violations":[
 {"beginLine":40,"endLine":43,"package":"Probe","function":null,"class":"Calculator",
  "method":"many","description":"The method many has 5 parameters. Consider reducing the number of parameters to 4 or less.",
  "rule":"ExcessiveParameterList","ruleSet":"Code Size Rules",
  "externalInfoUrl":"https://phpmd.org/rules/codesize.html#excessiveparameterlist","priority":3},
 {"beginLine":11,"endLine":11,"package":null,"function":null,"class":null,"method":null,
  "description":"Avoid variables with short names like $a. Configured minimum length is 3.",
  "rule":"ShortVariable","ruleSet":"Naming Rules",
  "externalInfoUrl":"https://phpmd.org/rules/naming.html#shortvariable","priority":3},
 {"beginLine":11,"endLine":11,"package":null,"function":null,"class":null,"method":null,
  "description":"Avoid variables with short names like $a. Configured minimum length is 3.",
  "rule":"ShortVariable","ruleSet":"Naming Rules",
  "externalInfoUrl":"https://phpmd.org/rules/naming.html#shortvariable","priority":3}]},
{"file":"/repo/tests/CalculatorTest.php","relativePath":"tests/CalculatorTest.php","violations":[
 {"beginLine":5,"endLine":90,"package":null,"function":null,"class":"CalculatorTest",
  "method":"testAll","description":"The method testAll() has 70 lines of code. Current threshold is set to 60. Avoid really long methods.",
  "rule":"ExcessiveMethodLength","ruleSet":"Code Size Rules",
  "externalInfoUrl":"https://phpmd.org/rules/codesize.html#excessivemethodlength","priority":3}]}],
"errors":[{"fileName":"/repo/src/Broken.php",
 "message":"Unexpected end of token stream in file: /repo/src/Broken.php."}]}`;

describe('parsePhpmdJson', () => {
  const found = parsePhpmdJson(JSON.parse(REPORT), (file) => file.replace('/repo/', ''));

  it('reads each violation with its span, once, and leaves test code its size limits', () => {
    expect(found.map((f) => f.rule)).toEqual([
      'phpmd/ExcessiveParameterList',
      'phpmd/ShortVariable',
      'phpmd/parse-error',
    ]);
    expect(found[0]).toEqual({
      rule: 'phpmd/ExcessiveParameterList',
      message:
        'The method many has 5 parameters. Consider reducing the number of parameters to 4 or less.',
      location: { file: 'src/Calculator.php', line: 40, endLine: 43 },
    });
  });

  it('reports a file PHPMD could not parse, without the path in the message', () => {
    expect(found[2]).toEqual({
      rule: 'phpmd/parse-error',
      message: 'PHPMD could not read this file: Unexpected end of token stream.',
      location: { file: 'src/Broken.php', line: 1 },
    });
  });

  it('refuses a shape it does not know', () => {
    expect(() => parsePhpmdJson({ files: [{}] }, (file) => file)).toThrow(EngineError);
  });
});

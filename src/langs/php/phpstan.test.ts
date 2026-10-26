import { describe, expect, it } from 'vitest';
import { bucketOf, parsePhpstanJson, phpstanFindings } from './phpstan.js';
import { EngineError } from '../../core/check.js';

// Recorded from PHPStan 2.3.1 (`analyse --error-format=json`), trimmed to a few messages.
const REPORT = `{"totals":{"errors":1,"file_errors":4},"files":{
"/repo/src/Calculator.php":{"errors":3,"messages":[
 {"message":"Constant Probe\\\\Calculator::UNUSED is unused.","line":9,"ignorable":true,
  "tip":"See: https://phpstan.org/developing-extensions/always-used-class-constants",
  "identifier":"classConstant.unused"},
 {"message":"Method Probe\\\\Calculator::untyped() has parameter $value with no type specified.",
  "line":16,"ignorable":true,"identifier":"missingType.parameter"},
 {"message":"Unused Probe\\\\Calculator::neverCalled","line":21,"ignorable":true,
  "identifier":"shipmonk.deadMethod"}]},
"/repo/src/Deep.php":{"errors":1,"messages":[
 {"message":"Cognitive complexity for \\"Probe\\\\Deep::nested()\\" is 22, keep it under 15",
  "line":60,"ignorable":true,"identifier":"complexity.functionLike"}]}},
"errors":["Ignored error pattern #Never matches# was not matched in reported errors."]}`;

const CLEAN = '{"totals":{"errors":0,"file_errors":0},"files":{},"errors":[]}';

const toRepo = (file: string): string => file.replace('/repo/', '');

describe('parsePhpstanJson', () => {
  it('reads each message with its file, line and identifier, and the general errors', () => {
    const parsed = parsePhpstanJson(JSON.parse(REPORT));
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[1]).toEqual({
      file: '/repo/src/Calculator.php',
      line: 16,
      identifier: 'missingType.parameter',
      message: 'Method Probe\\Calculator::untyped() has parameter $value with no type specified.',
    });
    expect(parsed.general).toEqual([
      'Ignored error pattern #Never matches# was not matched in reported errors.',
    ]);
  });

  it('reads a clean run, whose empty map PHP may print as a list', () => {
    expect(parsePhpstanJson(JSON.parse(CLEAN)).messages).toEqual([]);
    expect(parsePhpstanJson({ files: [], errors: [] }).messages).toEqual([]);
  });

  it('refuses a shape it does not know', () => {
    expect(() => parsePhpstanJson({ files: 'x' })).toThrow(EngineError);
  });
});

describe('bucketOf', () => {
  it('sends unused code to dead code, cognitive complexity to lint, the rest to types', () => {
    expect(bucketOf('shipmonk.deadMethod')).toBe('deadcode');
    expect(bucketOf('shipmonk.deadProperty.neverRead')).toBe('deadcode');
    expect(bucketOf('classConstant.unused')).toBe('deadcode');
    expect(bucketOf('property.onlyWritten')).toBe('deadcode');
    expect(bucketOf('deadCode.unreachable')).toBe('deadcode');
    expect(bucketOf('complexity.functionLike')).toBe('lint');
    expect(bucketOf('complexity.classLike')).toBe('lint');
    expect(bucketOf('equal.notAllowed')).toBe('types');
    expect(bucketOf('missingType.parameter')).toBe('types');
  });
});

describe('phpstanFindings', () => {
  it('makes findings per check, sentences with a full stop, unmatched ignores keyed', () => {
    const found = phpstanFindings(parsePhpstanJson(JSON.parse(REPORT)), toRepo);
    expect(found.deadcode.map((f) => f.rule)).toEqual([
      'phpstan/classConstant.unused',
      'phpstan/shipmonk.deadMethod',
    ]);
    expect(found.deadcode[1]).toMatchObject({
      message: 'Unused Probe\\Calculator::neverCalled.',
      location: { file: 'src/Calculator.php', line: 21 },
    });
    expect(found.lint).toEqual([
      {
        rule: 'phpstan/complexity.functionLike',
        message: 'Cognitive complexity for "Probe\\Deep::nested()" is 22, keep it under 15.',
        location: { file: 'src/Deep.php', line: 60 },
      },
    ]);
    expect(found.types.map((f) => f.rule)).toEqual([
      'phpstan/missingType.parameter',
      'phpstan/ignore.unmatched',
    ]);
    expect(found.types[1]?.key).toBe(
      'Ignored error pattern #Never matches# was not matched in reported errors.',
    );
  });

  it('takes an internal error for an engine error, since whole-project rules were skipped', () => {
    const parsed = { messages: [], general: ['Internal error: boom while analysing file x.php'] };
    expect(() => phpstanFindings(parsed, toRepo)).toThrow(/could not analyse everything/);
  });
});

import { describe, expect, it } from 'vitest';
import { parseComplexipySarif } from './complexipy.js';
import { EngineError } from '../../core/check.js';

// Recorded from complexipy 8.1.0 with --output-format sarif (tool.driver trimmed).
const SARIF = `{
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
  "runs": [{
    "results": [{
      "level": "warning",
      "locations": [{
        "logicalLocations": [{"kind": "function", "name": "branchy"}],
        "physicalLocation": {
          "artifactLocation": {"uri": "/repo/src/demo/calc.py", "uriBaseId": "%SRCROOT%"},
          "region": {"endLine": 22, "startLine": 16}
        }
      }],
      "message": {"text": "Function 'branchy' has a cognitive complexity of 10, which exceeds the maximum allowed complexity of 3."},
      "ruleId": "CC001"
    }],
    "tool": {"driver": {"name": "complexipy", "version": "8.1.0"}}
  }],
  "version": "2.1.0"
}`;

describe('parseComplexipySarif', () => {
  it('reads each function over the limit with its span and score', () => {
    expect(parseComplexipySarif(SARIF)).toEqual([
      {
        rule: 'CC001',
        file: '/repo/src/demo/calc.py',
        line: 16,
        endLine: 22,
        name: 'branchy',
        complexity: 10,
      },
    ]);
  });

  it('reads an empty run and refuses other shapes', () => {
    expect(parseComplexipySarif('{"runs": [{"results": []}]}')).toEqual([]);
    expect(() => parseComplexipySarif('{"runs": 1}')).toThrow(EngineError);
    expect(() => parseComplexipySarif('not json')).toThrow(EngineError);
  });
});

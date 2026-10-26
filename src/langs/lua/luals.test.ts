import { describe, expect, it } from 'vitest';
import { diagnosticFindings, headline, parseCheck, relativeTo, uriPath } from './luals.js';

// Recorded from lua-language-server 3.19.2: `--check --check_format=json`, one diagnostic.
const RECORDED = JSON.stringify({
  'file:///work/game/src/calc.lua': [
    {
      code: 'return-type-mismatch',
      message:
        'Annotations specify that return value #1 has a type of `string`, returning value of type `integer` here instead.\n- `integer` cannot match `string`\n- Type `integer` cannot match `string`',
      range: { end: { character: 10, line: 15 }, start: { character: 9, line: 15 } },
      severity: 2,
      source: 'Lua Diagnostics.',
    },
  ],
});

describe('parseCheck', () => {
  it('reads diagnostics by file', () => {
    const found = parseCheck(RECORDED);
    expect([...found.keys()]).toEqual(['file:///work/game/src/calc.lua']);
    expect(found.get('file:///work/game/src/calc.lua')?.[0]?.code).toBe('return-type-mismatch');
  });

  it('reads the empty array LuaLS writes when nothing is wrong', () => {
    expect(parseCheck('[]').size).toBe(0);
  });

  it('fails on output it cannot read', () => {
    expect(() => parseCheck('Diagnosis complete')).toThrow(/no readable JSON/);
    expect(() => parseCheck('{"file:///a.lua": [{"code": 1}]}')).toThrow(/unknown shape/);
  });
});

describe('paths', () => {
  it('reads POSIX and Windows file URIs', () => {
    expect(uriPath('file:///work/my%20game/a.lua')).toBe('/work/my game/a.lua');
    expect(uriPath('file:///c%3A/Users/runner/work/a.lua')).toBe('c:/Users/runner/work/a.lua');
    expect(uriPath('untitled:Untitled-1')).toBeUndefined();
  });

  it('makes paths relative to the component, ignoring case on Windows', () => {
    expect(relativeTo('/work/game/', '/work/game/src/a.lua', false)).toBe('src/a.lua');
    expect(relativeTo('/work/game', '/work/other/a.lua', false)).toBeUndefined();
    expect(relativeTo('C:\\Work\\Game', 'c:/Work/Game/src/A.lua', true)).toBe('src/A.lua');
    expect(relativeTo('/work/Game', '/work/game/a.lua', false)).toBeUndefined();
  });
});

describe('diagnosticFindings', () => {
  it('keeps the first line of the message and the 1-based span', () => {
    const diagnostics = parseCheck(RECORDED).get('file:///work/game/src/calc.lua') ?? [];
    expect(
      diagnosticFindings([{ file: 'src/calc.lua', repoFile: 'game/src/calc.lua', diagnostics }]),
    ).toEqual([
      {
        rule: 'luals/return-type-mismatch',
        message:
          'Annotations specify that return value #1 has a type of `string`, returning value of type `integer` here instead.',
        location: { file: 'game/src/calc.lua', line: 16, endLine: 16, column: 10 },
      },
    ]);
  });

  it('ends a headline with a full stop', () => {
    expect(headline('Undefined global `x`.')).toBe('Undefined global `x`.');
    expect(headline('Unused functions')).toBe('Unused functions.');
  });
});

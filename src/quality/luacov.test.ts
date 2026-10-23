import { describe, expect, it } from 'vitest';
import { LineScanner, luacovLines, luacovName, parseLuacovStats } from './luacov.js';

describe('luacovName', () => {
  it('names a file as a repository path would', () => {
    expect(luacovName('./src/calc.lua')).toBe('src/calc.lua');
    expect(luacovName('.\\src\\calc.lua')).toBe('src/calc.lua');
    expect(luacovName('././a.lua')).toBe('a.lua');
    expect(luacovName('/abs/a.lua')).toBe('/abs/a.lua');
  });
});

describe('parseLuacovStats', () => {
  it('reads each file’s hit counts, keeping only lines that were hit', () => {
    // luacov 0.17's format, as busted's run wrote it, cut to 12 lines.
    const stats = '12:./src/calc.lua\n0 1 0 0 0 0 0 1 2 2 1 0 \n3:spec\\calc_spec.lua\n1 0 2 \n';
    expect(parseLuacovStats(stats)).toEqual(
      new Map([
        [
          'src/calc.lua',
          new Map([
            [2, 1],
            [8, 1],
            [9, 2],
            [10, 2],
            [11, 1],
          ]),
        ],
        [
          'spec/calc_spec.lua',
          new Map([
            [1, 1],
            [3, 2],
          ]),
        ],
      ]),
    );
  });

  it('adds the counts of names that reach one file, and reads CRLF lines', () => {
    expect(parseLuacovStats('1:./a.lua\r\n4 \r\n1:a.lua\r\n1 \r\n')).toEqual(
      new Map([['a.lua', new Map([[1, 5]])]]),
    );
  });

  it('stops where the statistics stop making sense, as luacov does', () => {
    expect(parseLuacovStats('3:a.lua\n1 2')).toEqual(new Map([['a.lua', new Map([[1, 1]])]]));
    expect(parseLuacovStats('2:a.lua\n1 x 3 \n')).toEqual(new Map([['a.lua', new Map([[1, 1]])]]));
    expect(parseLuacovStats('3 a.lua\n')).toEqual(new Map());
    expect(parseLuacovStats('')).toEqual(new Map());
    expect(parseLuacovStats('1:last.lua')).toEqual(new Map([['last.lua', new Map()]]));
  });
});

// Each line with what luacov 0.17's own line scanner says of it (always excluded, excluded when
// not hit), recorded by running `luacov.linescanner` over these lines in order.
const SCANNED: [string, boolean, boolean][] = [
  ['#!/usr/bin/env lua', true, true],
  ['local M = {}', false, false],
  ['', true, true],
  ['local x', true, false],
  ['local a, b = 1, 2', false, false],
  ['local function f(a,', true, false],
  ['  b) return a end', false, false],
  ['M.name = "a\\"b" -- trailing', false, false],
  ['local s = [==[', false, true],
  ['still a string ]] here', true, true],
  [']==] .. "x"', false, false],
  ['--[[ long', true, true],
  ['comment ]] print(1)', false, false],
  ['if x then', false, false],
  ['  return 0x1p4 + .5 + 1e+5', false, false],
  ['end', true, false],
  ['else', true, false],
  ['{', false, true],
  ['},', false, true],
  ['foo,', false, true],
  ['["k"] = 3,', false, true],
  ['local t = function(a)', false, true],
  ['M.f = function()', false, true],
  ['goto done', false, true],
  ['::done::', false, true],
  ['break', false, true],
  ['-- luacov: disable', true, true],
  ['print("hidden")', true, true],
  ['--luacov:enable', true, true],
  ['print(\'shown\', "\\\\")', false, false],
  ['local y = nil', false, true],
  ['return function(...)', false, true],
  ["x = 'open", false, true],
  ["continued'", false, false],
  ['end)', true, false],
  ['while true do', true, false],
  ['local s2 = ("', false, true],
  ['")', false, false],
  ['a.b[c] = d', false, false],
  ['x()', false, false],
  ['local x = "multi\\', false, true],
  ['" .. y', false, false],
  ['local n = 3LL + 2ull + 1i', false, false],
  ['print(...)', false, false],
  ['[[', false, false],
  [']]', false, false],
  ['--[==[ c', true, true],
  [']==]', true, true],
  ['function M.g(', false, false],
  [')', true, true],
  ['"\\\\" .. x', false, false],
  ['x = 1\r', false, false],
  ['x = 0x1p-4 + 2P+1 + 0x.8p+2', false, false],
];

describe('LineScanner', () => {
  it('excludes the lines luacov’s scanner excludes', () => {
    const scanner = new LineScanner();
    const verdicts = SCANNED.map(([line]) => [line, ...scanner.consume(line)]);
    expect(verdicts).toEqual(SCANNED);
  });

  it('treats a shebang specially only on the first line', () => {
    const scanner = new LineScanner();
    expect(scanner.consume('x = 1')).toEqual([false, false]);
    expect(scanner.consume('#!/usr/bin/env lua')).toEqual([false, false]);
  });
});

// Recorded with busted 2.3 and luacov 0.17: the source, its statistics, and the lines luacov's
// reporter (without cluacov) lists with their hits.
const CALC = `---@class Calc
local calc = {}

---Adds two numbers.
---@param a number
---@param b number
---@return number
function calc.add(a, b)
    local unused = 1
    return a + b
end

---@param n integer
---@return string
function calc.name(n)
  return n
end

function calc.never(x)
    if x then
        return 1
    end
    return 2
end

local function helper() end

return calc
`;

const CALC_STATS = '28:./src/calc.lua\n0 1 0 0 0 0 0 1 2 2 1 0 0 0 1 1 1 0 1 0 0 0 0 1 0 1 0 1 \n';

describe('luacovLines', () => {
  it('counts the lines luacov’s reporter counts, with their hits', () => {
    const hits = parseLuacovStats(CALC_STATS).get('src/calc.lua') ?? new Map<number, number>();
    expect([...luacovLines(CALC, hits)]).toEqual([
      [2, 1],
      [8, 1],
      [9, 2],
      [10, 2],
      [15, 1],
      [16, 1],
      [19, 1],
      [20, 0],
      [21, 0],
      [23, 0],
      [26, 1],
      [28, 1],
    ]);
  });

  it('counts a line excluded only when not hit once a test hits it', () => {
    const source = 'local t = {\n  foo,\n}\n';
    expect([...luacovLines(source, new Map())]).toEqual([[1, 0]]);
    expect([...luacovLines(source, new Map([[2, 3]]))]).toEqual([
      [1, 0],
      [2, 3],
    ]);
  });

  it('reads a source without a final newline, and an empty one', () => {
    expect([...luacovLines('x = 1', new Map())]).toEqual([[1, 0]]);
    expect([...luacovLines('', new Map())]).toEqual([]);
  });
});

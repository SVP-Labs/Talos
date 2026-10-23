import { describe, expect, it } from 'vitest';
import { rewriteMessage } from './format.js';
import { parseStylua } from './stylua.js';

// Recorded from stylua 2.6.0: `--check --output-format Json`, one object per changed file.
const RECORDED = [
  '{"file":"src/calc.lua","mismatches":[{"expected":"    return n\\n","expected_end_line":15,"expected_start_line":15,"original":"  return n\\n","original_end_line":15,"original_start_line":15}]}',
  '{"file":"crlf.lua","mismatches":[{"expected":"local y = 1\\nlocal z = 2\\n","expected_end_line":1,"expected_start_line":0,"original":"local y = 1\\r\\nlocal z=2\\r\\n","original_end_line":1,"original_start_line":0}]}',
  '',
].join('\n');

describe('parseStylua', () => {
  it('turns 0-based hunks into 1-based spans', () => {
    expect(parseStylua(RECORDED)).toEqual([
      { file: 'src/calc.lua', line: 16, endLine: 16 },
      { file: 'crlf.lua', line: 1, endLine: 2 },
    ]);
  });

  it('reads nothing from a clean run', () => {
    expect(parseStylua('')).toEqual([]);
  });

  it('fails on an error object, such as a file that is missing', () => {
    const missing = '{"message":"no file or directory found matching \'x.lua\'","type":"error"}';
    expect(() => parseStylua(missing)).toThrow(/no file or directory/);
  });

  it('fails on output it cannot read', () => {
    expect(() => parseStylua('Diff in x.lua')).toThrow(/isn't JSON/);
    expect(() => parseStylua('{"file":"x.lua"}')).toThrow(/unknown shape/);
  });
});

describe('rewriteMessage', () => {
  it('names the line or lines StyLua would rewrite', () => {
    expect(rewriteMessage(7, 7)).toBe('StyLua would rewrite line 7.');
    expect(rewriteMessage(7, 8)).toBe('StyLua would rewrite lines 7 to 8.');
  });
});

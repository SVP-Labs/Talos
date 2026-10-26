import { describe, expect, it } from 'vitest';
import {
  configError,
  eventFinding,
  isDeadCode,
  parseLuacheck,
  ruleOf,
  sentence,
} from './luacheck.js';
import type { Bound } from './run.js';

// Recorded from luacheck 1.2.0 with Talos's formatter, over a file with warnings and one with
// a syntax error.
const RECORDED =
  '{"files":[{"error":"","events":[{"code":"211","column":7,"endColumn":7,"line":2,"message":"unused variable \'x\'"},{"code":"212","column":17,"endColumn":17,"line":3,"message":"unused argument \'q\'"},{"code":"111","column":1,"endColumn":1,"line":6,"message":"setting non-standard global variable \'y\'"},{"code":"113","column":5,"endColumn":18,"line":6,"message":"accessing undefined variable \'undefined_name\'"}],"fatal":"","file":"src/a.lua"},{"error":"","events":[{"code":"011","column":7,"endColumn":7,"line":1,"message":"expected identifier near \'=\'"}],"fatal":"","file":"src/bad.lua"}]}\n';

const ctx = {
  root: '/repo',
  component: { lang: 'lua', root: 'game', os: ['linux'] },
  os: 'linux',
} as unknown as Bound;

describe('parseLuacheck', () => {
  it('reads every checked file and its warnings', () => {
    const files = parseLuacheck(RECORDED);
    expect(files.map((f) => [f.file, f.events.map((e) => e.code)])).toEqual([
      ['src/a.lua', ['211', '212', '111', '113']],
      ['src/bad.lua', ['011']],
    ]);
  });

  it('treats a file luacheck could not read as an engine error', () => {
    const fatal =
      '{"files":[{"error":"couldn\'t read: No such file or directory","events":[],"fatal":"I/O","file":"gone.lua"}]}';
    expect(() => parseLuacheck(fatal)).toThrow(/couldn't check gone.lua/);
  });

  it('fails on output it cannot read', () => {
    expect(() => parseLuacheck('Checking a.lua OK')).toThrow(/no readable JSON/);
    expect(() => parseLuacheck('{"files":[{"file":"a.lua"}]}')).toThrow(/unknown shape/);
  });
});

describe('isDeadCode', () => {
  it('takes unused values, labels and unreachable code', () => {
    for (const code of ['131', '211', '212', '213', '231', '311', '314', '331', '511', '521']) {
      expect(isDeadCode(code)).toBe(true);
    }
  });

  it('leaves globals, shadowing, style and complexity to lint', () => {
    for (const code of ['011', '111', '113', '214', '411', '512', '561', '631']) {
      expect(isDeadCode(code)).toBe(false);
    }
  });
});

describe('configError', () => {
  // Recorded: a project file that requires a missing module, and an unknown std.
  it("recognises the project's configuration failing to load", () => {
    const missing = {
      code: 4,
      stdout: '',
      stderr:
        "Critical error: Couldn't load configuration from .luacheckrc: runtime error (line 1: module 'nope' not found:\n\tno field package.preload['nope']\n",
    };
    expect(configError(missing)).toBe(
      "Couldn't load configuration from .luacheckrc: runtime error (line 1: module 'nope' not found:",
    );
    const invalid = {
      code: 4,
      stdout: '',
      stderr:
        "Critical error: in config loaded from .luacheckrc: invalid value of option 'std': unknown std 'lua99'\n",
    };
    expect(configError(invalid)).toMatch(/^in config loaded from/);
  });

  it('leaves other exits alone', () => {
    expect(configError({ code: 1, stdout: '{}', stderr: '' })).toBeUndefined();
    const formatter = {
      code: 4,
      stdout: '',
      stderr: "Critical error: Couldn't load custom formatter 'x': not found\n",
    };
    expect(configError(formatter)).toBeUndefined();
  });
});

describe('findings', () => {
  it('names rules as luacheck prints codes, and writes sentences', () => {
    expect(ruleOf('211')).toBe('luacheck/W211');
    expect(ruleOf('011')).toBe('luacheck/E011');
    expect(sentence("unused variable 'x'")).toBe("Unused variable 'x'.");
    expect(sentence('Done!')).toBe('Done!');
  });

  it('places a warning in the repository', () => {
    const event = { code: '113', line: 6, column: 5, endColumn: 18, message: 'accessing x' };
    expect(eventFinding(ctx, 'src/a.lua', event)).toEqual({
      rule: 'luacheck/W113',
      message: 'Accessing x.',
      location: { file: 'game/src/a.lua', line: 6, endLine: 6, column: 5 },
    });
  });
});

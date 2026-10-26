import { describe, expect, it } from 'vitest';
import {
  LUA_GENERATED,
  LUACHECK_OPTIONS,
  LUALS_DISABLED,
  luarcSettings,
  renderLuacheck,
  renderLuarc,
  renderStylua,
} from './configs.js';
import { parseConfig } from '../../config/load.js';
import { GENERATED_MARKER } from '../../configs/header.js';
import { repoFacts } from '../../repo/facts.js';

describe('generated configs', () => {
  it('writes StyLua with every option pinned', () => {
    const text = renderStylua('1.2.3');
    expect(text.split('\n')[0]).toBe(`# ${GENERATED_MARKER} 1.2.3. Do not edit.`);
    expect(text).toContain('column_width = 120\n');
    expect(text).toContain('indent_type = "Spaces"\n');
    expect(text).toContain('syntax = "Lua54"\n');
    expect(text).toContain('[sort_requires]\nenabled = false\n');
  });

  it("writes luacheck's base, which returns the project's settings when the file exists", () => {
    const text = renderLuacheck('1.2.3');
    expect(text.split('\n')[0]).toBe(
      `-- ${GENERATED_MARKER} 1.2.3. Do not edit: extend it in luacheck_project.lua, which may only tighten it.`,
    );
    expect(text).toContain('std = "lua54"\n');
    expect(text).toContain(
      `max_cyclomatic_complexity = ${LUACHECK_OPTIONS.maxCyclomaticComplexity}\n`,
    );
    expect(text).toContain('ignore = { "611", "612", "614", "621" }\n');
    expect(text).toContain(
      '-- A long string is the text it holds; StyLua leaves it as it is.\nmax_string_line_length = false\n',
    );
    expect(text).toContain('local found, project = pcall(require, "luacheck_project")\n');
    expect(text).toContain(`find("module 'luacheck_project' not found", 1, true)`);
  });

  it("writes LuaLS's settings as JSON with the note under a key", () => {
    const parsed: unknown = JSON.parse(renderLuarc('1.2.3'));
    expect(parsed).toMatchObject({
      '//': `${GENERATED_MARKER} 1.2.3. Do not edit.`,
      'runtime.version': 'Lua 5.4',
    });
    const settings = luarcSettings();
    expect(settings['diagnostics.groupFileStatus']).toMatchObject({
      strong: 'Any',
      codestyle: 'None',
    });
    expect(settings['diagnostics.disable']).toEqual(LUALS_DISABLED);
  });

  it('applies to components with Lua files only', () => {
    const config = parseConfig('name: T\nprefix: T\ncomponents:\n  - { lang: lua, root: game }\n');
    const component = config.components[0];
    if (component === undefined) throw new Error('no component');
    const base = { config, component, side: 'alone', tiers: ['commit'] } as const;
    const withLua = { ...base, facts: repoFacts(['game/src/a.lua'], []) };
    const without = { ...base, facts: repoFacts(['other/a.lua', 'game/.lua/x.lua'], []) };
    expect(LUA_GENERATED.map((g) => g.applies(withLua))).toEqual([true, true, true]);
    expect(LUA_GENERATED.map((g) => g.applies(without))).toEqual([false, false, false]);
  });
});

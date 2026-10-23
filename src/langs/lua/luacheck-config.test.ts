import { describe, expect, it } from 'vitest';
import { parseLoadedConfig, weakerLuacheck, weakerStd } from './luacheck-config.js';

// Recorded from Talos's config script with luacheck 1.2.0: the generated base, with a project
// file that ignores 212/self, turns the line length off and loosens spec/.
const RECORDED =
  '{"error":"","files":[{"glob":"**/*.luacheckrc","options":[{"name":"std","value":"+luacheckrc"}]},{"glob":"**/*.rockspec","options":[{"name":"std","value":"+rockspec"}]},{"glob":"**/config.ld","options":[{"name":"std","value":"+ldoc"}]},{"glob":"**/spec/**/*_spec.lua","options":[{"name":"std","value":"+busted"}]},{"glob":"**/test/**/*_spec.lua","options":[{"name":"std","value":"+busted"}]},{"glob":"**/tests/**/*_spec.lua","options":[{"name":"std","value":"+busted"}]},{"glob":"spec/","options":[{"name":"std","value":"+busted+max"},{"name":"max_cyclomatic_complexity","value":20}]}],"top":[{"name":"std","value":"lua54"},{"name":"max_line_length","value":false},{"name":"max_code_line_length","value":120},{"name":"max_string_line_length","value":false},{"name":"max_comment_line_length","value":120},{"name":"max_cyclomatic_complexity","value":12},{"name":"ignore","value":["212/self"]},{"name":"exclude_files","value":[".lua/",".luarocks/","lua_modules/"]}]}\n';

// Recorded: the base alone, as luacheck loads it with the initial project file.
const BASE =
  '{"error":"","files":[{"glob":"**/*.luacheckrc","options":[{"name":"std","value":"+luacheckrc"}]},{"glob":"**/*.rockspec","options":[{"name":"std","value":"+rockspec"}]},{"glob":"**/config.ld","options":[{"name":"std","value":"+ldoc"}]},{"glob":"**/spec/**/*_spec.lua","options":[{"name":"std","value":"+busted"}]},{"glob":"**/test/**/*_spec.lua","options":[{"name":"std","value":"+busted"}]},{"glob":"**/tests/**/*_spec.lua","options":[{"name":"std","value":"+busted"}]}],"top":[{"name":"std","value":"lua54"},{"name":"max_line_length","value":120},{"name":"max_code_line_length","value":120},{"name":"max_string_line_length","value":false},{"name":"max_comment_line_length","value":120},{"name":"max_cyclomatic_complexity","value":12},{"name":"ignore","value":["611","612","614","621"]},{"name":"exclude_files","value":[".lua/",".luarocks/","lua_modules/"]}]}\n';

describe('parseLoadedConfig', () => {
  it('reads the top level and each pattern', () => {
    const config = parseLoadedConfig(RECORDED);
    expect(config?.top.get('max_line_length')).toBe(false);
    expect(config?.files.map((f) => f.glob)).toContain('spec/');
  });

  it('says nothing about a configuration that does not load, which lua/lint reports', () => {
    const failure =
      '{"error":"in config loaded from .luacheckrc: invalid value of option \'std\': unknown std \'lua99\'"}';
    expect(parseLoadedConfig(failure)).toBeUndefined();
  });

  it('fails on output it cannot read', () => {
    expect(() => parseLoadedConfig('nil')).toThrow(/no JSON/);
    expect(() => parseLoadedConfig('{"top":[]}')).toThrow(/unknown shape/);
  });
});

describe('weakerLuacheck', () => {
  it('finds nothing weaker in the base', () => {
    const config = parseLoadedConfig(BASE);
    expect(config && weakerLuacheck(config)).toEqual([]);
  });

  it('reports each loosened setting, per pattern too', () => {
    const config = parseLoadedConfig(RECORDED);
    expect(config && weakerLuacheck(config).map((w) => w.setting)).toEqual([
      'max_line_length',
      'ignore 212/self',
      'files["spec/"] std',
      'files["spec/"] max_cyclomatic_complexity',
    ]);
  });

  it('reports switches and lists that relax a check', () => {
    const top = [
      { name: 'unused', value: false },
      { name: 'allow_defined_top', value: true },
      { name: 'only', value: ['1'] },
      { name: 'exclude_files', value: ['.lua/', 'vendor/'] },
      { name: 'include_files', value: ['src/**'] },
      { name: 'module', value: true },
      { name: 'max_cyclomatic_complexity', value: 8 },
    ];
    const config = parseLoadedConfig(JSON.stringify({ error: '', top, files: [] }));
    expect(config && weakerLuacheck(config).map((w) => w.how)).toEqual([
      'sets unused to false, which turns its warnings off',
      'sets allow_defined_top to true',
      'checks only "1"',
      'skips "vendor/"',
      'checks only the files matching "src/**"',
    ]);
  });
});

describe('weakerStd', () => {
  it("allows lua54, narrower stds, and the host's globals", () => {
    for (const std of ['lua54', 'lua54+busted', '+love', 'min', 'none+ngx', 'lua54+game']) {
      expect(weakerStd(std)).toBeUndefined();
    }
  });

  it('rejects another Lua, every Lua, or a table of its own', () => {
    expect(weakerStd('max')).toMatch(/instead of lua54/);
    expect(weakerStd('luajit')).toMatch(/instead of lua54/);
    expect(weakerStd('lua54+lua51')).toMatch(/adds std "lua51"/);
    expect(weakerStd('+lua54c')).toMatch(/adds std "lua54c"/);
    expect(weakerStd(['x'])).toMatch(/table/);
  });
});

import { describe, expect, it } from 'vitest';
import { devtoolsLock, devtoolsRockspec, LOCKED_ROCKS, LUA_DEV_TOOLS } from './devtools.js';

describe('dev tools', () => {
  it('locks each pinned tool at its pinned version', () => {
    for (const [name, version] of Object.entries(LUA_DEV_TOOLS.packages)) {
      expect(LOCKED_ROCKS[name]).toBe(version);
    }
  });

  it('writes a rockspec depending on exactly the pinned tools', () => {
    const rockspec = devtoolsRockspec({ manager: 'luarocks', packages: { busted: '2.3.0-1' } });
    expect(rockspec).toContain('package = "talos-devtools"');
    expect(rockspec).toContain('dependencies = {\n   "busted == 2.3.0-1",\n}');
    expect(rockspec).toContain('build = { type = "none" }');
  });

  it("writes LuaRocks's lockfile, sorted, without Lua itself", () => {
    expect(devtoolsLock({ say: '1.4.1-3', 'lua-term': '0.8-1' })).toBe(
      'return {\n   dependencies = {\n      ["lua-term"] = "0.8-1",\n      ["say"] = "1.4.1-3",\n   },\n}\n',
    );
    expect(Object.keys(LOCKED_ROCKS)).not.toContain('lua');
  });
});

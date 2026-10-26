import { describe, expect, it } from 'vitest';
import {
  fromTool,
  inComponent,
  inRepo,
  isTestPath,
  luaFiles,
  type Place,
  scriptEnv,
  sourceFiles,
  specFiles,
  treeProgram,
} from './paths.js';
import type { Component } from '../../core/check.js';
import { repoFacts } from '../../repo/facts.js';

const game: Component = { lang: 'lua', root: 'game', os: ['linux', 'windows'] };

describe('paths', () => {
  it('moves between repository and component paths', () => {
    expect(inComponent('game', 'game/src/a.lua')).toBe('src/a.lua');
    expect(inComponent('game/', 'other/a.lua')).toBeUndefined();
    expect(inComponent('.', 'src/a.lua')).toBe('src/a.lua');
    expect(inRepo('game', 'src/a.lua')).toBe('game/src/a.lua');
    expect(inRepo('.', 'src/a.lua')).toBe('src/a.lua');
  });

  it("reads tools' paths, relative or absolute", () => {
    const place = { root: '/work', component: game };
    expect(fromTool(place, './src/a.lua')).toBe('game/src/a.lua');
    expect(fromTool(place, 'src\\a.lua')).toBe('game/src/a.lua');
    expect(fromTool(place, '/work/game/src/a.lua')).toBe('game/src/a.lua');
  });

  it("lists the component's Lua files without the installed tree", () => {
    const facts = repoFacts(['game/src/a.lua', 'game/.lua/x.lua', 'game/README.md', 'b.lua'], []);
    expect(luaFiles({ facts, component: game })).toEqual(['src/a.lua']);
  });

  it('tells tests from sources', () => {
    const files = [
      'src/a.lua',
      'spec/a_spec.lua',
      'spec/helper.lua',
      'test/b.lua',
      'luacheck_project.lua',
    ];
    expect(files.filter((f) => isTestPath(f))).toEqual([
      'spec/a_spec.lua',
      'spec/helper.lua',
      'test/b.lua',
    ]);
    expect(specFiles(files)).toEqual(['spec/a_spec.lua']);
    expect(sourceFiles(files)).toEqual(['src/a.lua']);
  });

  it("finds the tree's programs on each OS", () => {
    const linux: Place = { root: '/work', component: game, os: 'linux' };
    const windows: Place = { root: 'C:\\work', component: game, os: 'windows' };
    expect(treeProgram(linux, 'luacheck')).toBe('/work/game/.lua/bin/luacheck');
    expect(treeProgram(windows, 'luacheck').endsWith('luacheck.bat')).toBe(true);
    expect(treeProgram(windows, 'lua').endsWith('lua.exe')).toBe(true);
  });

  it("gives Talos's scripts the tree's modules only", () => {
    const env = scriptEnv({ root: '/work', component: game, os: 'linux' });
    expect(env.LUA_PATH_5_4).toBe(
      '/work/game/.lua/share/lua/5.4/?.lua;/work/game/.lua/share/lua/5.4/?/init.lua',
    );
    expect(env.LUA_CPATH_5_4).toBe('/work/game/.lua/lib/lua/5.4/?.so');
    expect(env.LUA_PATH_5_4).not.toContain('./?.lua');
  });
});

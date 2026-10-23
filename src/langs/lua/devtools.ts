import type { DevTools } from '../../core/pack.js';

/** The Lua every component's tree is built with, and the LuaRocks that installs into it. */
export const LUA_VERSION = '5.4.9';
export const LUAROCKS_VERSION = '3.13.0';

/** The rocks the checks run, at exactly these versions; `lua/toolchain` keeps them so. */
export const LUA_DEV_TOOLS: DevTools = {
  manager: 'luarocks',
  packages: {
    busted: '2.3.0-1',
    cluacov: '1.0.0-1',
    luacheck: '1.2.0-1',
    luacov: '0.17.0-1',
  },
};

/**
 * Every rock the dev tools bring, as `luarocks make --pin` recorded them: LuaRocks installs a
 * locked dependency without resolving its own, so this list is the whole closure.
 */
export const LOCKED_ROCKS: Readonly<Record<string, string>> = {
  argparse: '0.7.2-1',
  busted: '2.3.0-1',
  cluacov: '1.0.0-1',
  datafile: '0.11-1',
  dkjson: '2.11-1',
  'lua-term': '0.8-1',
  lua_cliargs: '3.0.2-1',
  luacheck: '1.2.0-1',
  luacov: '0.17.0-1',
  luafilesystem: '1.9.0-1',
  luassert: '1.9.0-1',
  luasystem: '0.7.1-1',
  mediator_lua: '1.1.2-0',
  penlight: '1.15.0-1',
  say: '1.4.1-3',
};

/** The rockspec whose dependencies are the dev tools, for `luarocks make --deps-only`. */
export const DEVTOOLS_ROCKSPEC = 'talos-devtools-0-0.rockspec';

function luaString(text: string): string {
  return JSON.stringify(text);
}

export function devtoolsRockspec(tools: DevTools = LUA_DEV_TOOLS): string {
  const dependencies = Object.entries(tools.packages).map(([name, version]) => {
    const pin = luaString(`${name} == ${version}`);
    return `   ${pin},`;
  });
  return [
    'rockspec_format = "3.0"',
    'package = "talos-devtools"',
    'version = "0-0"',
    'source = { url = "" }',
    'dependencies = {',
    ...dependencies,
    '}',
    'build = { type = "none" }',
    '',
  ].join('\n');
}

/** LuaRocks's lockfile, which `luarocks make` reads from the directory of the rockspec. */
export function devtoolsLock(locked: Readonly<Record<string, string>> = LOCKED_ROCKS): string {
  const entries = Object.entries(locked)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => `      [${luaString(name)}] = ${luaString(version)},`);
  return ['return {', '   dependencies = {', ...entries, '   },', '}', ''].join('\n');
}

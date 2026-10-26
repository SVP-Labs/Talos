import { access } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import type { ApplyContext, CheckContext, Component } from '../../core/check.js';
import { EngineError } from '../../core/check.js';
import { underRoot } from '../../repo/facts.js';

/** Where a component's programs are: the checkout, the component, and the OS it runs on. */
export type Place = Pick<CheckContext, 'root' | 'os'> & { readonly component: Component };

/** The tree `install()` builds in the component's root: Lua, LuaRocks and the rocks. */
export const TREE = '.lua';

/** The project's own luacheck settings, which the generated `.luacheckrc` loads. */
export const LUACHECK_PROJECT = 'luacheck_project.lua';

/** The component a component check runs for; the engine always sets it. */
export function component(ctx: { readonly component?: Component }): Component {
  if (ctx.component !== undefined) return ctx.component;
  throw new EngineError('a lua check ran without a component');
}

/** The component's directory, absolute. */
export function componentDir(place: Pick<Place, 'root' | 'component'>): string {
  return join(place.root, place.component.root);
}

/** A path without the slashes it ends with. */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/** A repository-relative path made relative to the component's root, or undefined outside it. */
export function inComponent(root: string, path: string): string | undefined {
  const inside = posix.relative(posix.normalize(root), posix.normalize(path));
  return inside === '' || inside === '..' || inside.startsWith('../') ? undefined : inside;
}

/** A component-relative path made repository-relative. */
export function inRepo(root: string, path: string): string {
  return posix.join(root, path);
}

/** A path a tool printed (absolute, or relative to the component) made repository-relative. */
export function fromTool(place: Pick<Place, 'root' | 'component'>, file: string): string {
  const path = isAbsolute(file) ? relative(place.root, file) : inRepo(place.component.root, file);
  return posix.normalize(path.replaceAll('\\', '/'));
}

/** The component's tracked Lua sources, relative to its root, the installed tree left out. */
export function luaFiles(ctx: Pick<ApplyContext, 'facts' | 'component'>): string[] {
  const root = component(ctx).root;
  return underRoot(ctx.facts.matching('**/*.lua'), root)
    .map((file) => inComponent(root, file))
    .filter((file): file is string => file !== undefined && !file.startsWith(`${TREE}/`));
}

/** Test code as busted lays it out: `*_spec.lua` files and anything under a spec or test dir. */
export function isTestPath(path: string): boolean {
  return path.endsWith('_spec.lua') || /(?:^|\/)(?:spec|tests?)\//.test(path);
}

/** The files busted runs: every `*_spec.lua`. */
export function specFiles(files: readonly string[]): string[] {
  return files.filter((file) => file.endsWith('_spec.lua'));
}

/** Code the coverage measures: everything but tests and the project's luacheck settings. */
export function sourceFiles(files: readonly string[]): string[] {
  return files.filter((file) => !isTestPath(file) && file !== LUACHECK_PROJECT);
}

export async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The installed tree's directory, absolute. */
export function treeDir(place: Pick<Place, 'root' | 'component'>): string {
  return join(componentDir(place), TREE);
}

/**
 * A program in the tree's `bin`: the Lua interpreter is an executable everywhere; LuaRocks and
 * the rocks' commands are shell scripts, which are `.bat` files on Windows.
 */
export function treeProgram(place: Place, name: string): string {
  const bin = join(treeDir(place), 'bin');
  if (place.os !== 'windows') return join(bin, name);
  return join(bin, name === 'lua' ? 'lua.exe' : `${name}.bat`);
}

/** A program the tree must have, or an engine error naming what is missing. */
export async function installedProgram(place: Place, name: string): Promise<string> {
  const path = treeProgram(place, name);
  if (await fileExists(path)) return path;
  throw new EngineError(
    `${name} is not installed in ${inRepo(place.component.root, TREE)}: install() did not run`,
  );
}

/**
 * The environment for Talos's own Lua scripts: modules from the tree only, so nothing in the
 * component's directory can stand in for luacheck or luacov, and no startup code from the
 * environment. Lua 5.4 reads the `_5_4` names before the plain ones.
 */
export function scriptEnv(place: Place): Record<string, string> {
  const tree = treeDir(place).replaceAll('\\', '/');
  const lua = [`${tree}/share/lua/5.4/?.lua`, `${tree}/share/lua/5.4/?/init.lua`].join(';');
  const native = `${tree}/lib/lua/5.4/?.${place.os === 'windows' ? 'dll' : 'so'}`;
  return { LUA_PATH_5_4: lua, LUA_CPATH_5_4: native, LUA_INIT_5_4: '', LUA_INIT: '' };
}

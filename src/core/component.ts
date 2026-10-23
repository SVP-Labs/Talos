import { access } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { type Component, EngineError, type Lang, type Os } from './check.js';
import type { ExecResult } from '../exec/exec.js';

/** Where a component's tools run: its checkout and the OS it runs on. */
export type Place = {
  readonly root: string;
  readonly component: Component;
  readonly os: Os;
};

/** The component a component-scoped check runs for. */
export function componentOf(ctx: { readonly component?: Component }, lang: Lang): Component {
  if (ctx.component === undefined) throw new EngineError(`a ${lang} check ran without a component`);
  return ctx.component;
}

/** The component's directory, absolute. */
export function componentDir(place: Pick<Place, 'root' | 'component'>): string {
  return place.component.root === '.' ? place.root : join(place.root, place.component.root);
}

function prefix(root: string): string {
  let end = root.length;
  while (end > 0 && root[end - 1] === '/') end -= 1;
  return root === '.' || end === 0 ? '' : `${root.slice(0, end)}/`;
}

/** A repository-relative path made relative to the component's root, or undefined outside it. */
export function inComponent(root: string, path: string): string | undefined {
  const start = prefix(root);
  return path.startsWith(start) ? path.slice(start.length) : undefined;
}

/** A component-relative path made repository-relative. */
export function inRepo(root: string, path: string): string {
  return posix.normalize(`${prefix(root)}${path}`);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The last lines of a tool's output, for an engine error's message. */
export function tail(result: ExecResult, lines = 15): string {
  return (result.stderr || result.stdout).trim().split('\n').slice(-lines).join('\n');
}

export function failed(what: string, result: ExecResult): EngineError {
  return new EngineError(`${what} exited ${result.code}:\n${tail(result)}`);
}

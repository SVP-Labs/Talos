import { posix } from 'node:path';
import type { ApplyContext, Component } from '../../core/check.js';
import { underRoot } from '../../repo/facts.js';

export const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
export const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'] as const;

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const JAVASCRIPT = /\.(?:[cm]?js|jsx)$/;

/** Test code: test and spec files, and whatever sits in a test, e2e or testing directory. */
const TEST = /(?:(?:^|\/)(?:tests?|e2e|testing|__tests__)\/)|(?:\.(?:test|spec)\.[cm]?[jt]sx?$)/;

/** The same set as globs, for tools that take globs. */
export const TEST_GLOBS = [
  '**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  '**/{test,tests,e2e,testing,__tests__}/**',
] as const;

/** Tool configuration rather than source: `*.config.*`, Talos's `*.project.*`, dotfiles. */
const TOOLING = /(?:^|\/)(?:[^/]*\.(?:config|project)\.[cm]?[jt]s|\.[^/]+\.[cm]?js)$/;

export const LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] as const;

export function isCode(path: string): boolean {
  return CODE.test(path);
}

export function isJavaScript(path: string): boolean {
  return JAVASCRIPT.test(path);
}

export function isTest(path: string): boolean {
  return TEST.test(path);
}

export function isTooling(path: string): boolean {
  return TOOLING.test(path);
}

/** The path without trailing slashes. */
export function stripSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/** The component's root with no trailing slash, `.` for the repository root. */
export function rootOf(component: Component | undefined): string {
  const root = stripSlashes(component?.root ?? '.');
  return root === '' ? '.' : root;
}

/** A repository-relative path made relative to the component's root. */
export function inComponent(root: string, path: string): string {
  return root === '.' ? path : posix.relative(root, path);
}

/** A component-relative path (as a tool printed it, on any OS) made repository-relative. */
export function inRepo(root: string, path: string): string {
  const portable = path.replaceAll('\\', '/');
  return root === '.' ? portable : posix.join(root, portable);
}

/** The component's tracked files (minus `exclude`), repository-relative. */
export function componentFiles(ctx: ApplyContext): string[] {
  return underRoot(ctx.facts.files, rootOf(ctx.component));
}

/** The component's tracked `tsconfig.json` files, repository-relative. */
export function tsconfigs(ctx: ApplyContext): string[] {
  return componentFiles(ctx).filter((file) => posix.basename(file) === 'tsconfig.json');
}

/**
 * `talos.yml`'s `exclude` entries that fall under the component, relative to its root; an entry
 * naming the component's root itself or something outside it is left out.
 */
export function excludedHere(excludes: readonly string[], root: string): string[] {
  return excludes.flatMap((entry) => {
    const trimmed = stripSlashes(entry);
    if (root === '.') return [trimmed];
    const relative = posix.relative(root, trimmed);
    return relative === '' || relative.startsWith('..') ? [] : [relative];
  });
}

/** `tests.full` paths under the component, relative to its root. */
export function fullTestsHere(full: readonly string[], root: string): string[] {
  return excludedHere(full, root);
}

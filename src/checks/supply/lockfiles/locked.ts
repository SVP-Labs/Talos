import { z } from 'zod';
import { EngineError } from '../../../core/check.js';

/** The public registries Talos asks about a locked version. */
export type Ecosystem = 'npm' | 'pypi' | 'packagist' | 'crates';

/**
 * Where a locked version comes from: a registry (`public` when it is the ecosystem's public one),
 * the repository itself (a workspace member, a local directory), or a git repository or URL.
 */
export type Source =
  | { readonly kind: 'registry'; readonly public: boolean }
  | { readonly kind: 'local' }
  | { readonly kind: 'git' | 'url'; readonly from: string };

export type Locked = {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  readonly source: Source;
  /** The licences the lockfile itself records for the version, where it records any. */
  readonly licences?: readonly string[];
};

export const PUBLIC_REGISTRY: Source = { kind: 'registry', public: true };
export const LOCAL: Source = { kind: 'local' };

const ARCHIVE = /\.(?:tgz|tar|tar\.gz|tar\.bz2|tar\.xz|zip|whl|crate)$/i;

/** The text before the first of `marks`, or all of it. */
export function before(text: string, marks: readonly string[]): string {
  const cut = marks.map((mark) => text.indexOf(mark)).filter((index) => index >= 0);
  return cut.length === 0 ? text : text.slice(0, Math.min(...cut));
}

/** Whether a path or URL names an archive rather than a directory. */
export function isArchive(path: string): boolean {
  return ARCHIVE.test(before(path, ['?', '#']));
}

/** A URL without its credentials or query, safe to put in a finding. */
export function shownSource(from: string): string {
  return from.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1').replace(/\?[^#]*/, '');
}

export function fromGit(from: string): Source {
  return { kind: 'git', from: shownSource(from) };
}

export function fromUrl(from: string): Source {
  return { kind: 'url', from: shownSource(from) };
}

/** A local file dependency: an archive is a tarball dependency, a directory is the project's. */
export function fromFile(path: string): Source {
  return isArchive(path) ? fromUrl(path) : LOCAL;
}

const NPM_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);

/**
 * How npm, Yarn and pnpm record where a version was downloaded from: a registry tarball
 * (`…/<name>/-/<base>-<version>.tgz`), a git URL, a local path, or any other URL.
 */
export function npmSource(name: string, version: string, resolved: string): Source {
  if (/^(?:git\+|git:|git@|github:|gitlab:|bitbucket:)/.test(resolved)) return fromGit(resolved);
  if (resolved.startsWith('file:')) return fromFile(resolved.slice('file:'.length));
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return fromUrl(resolved);
  }
  const base = name.slice(name.lastIndexOf('/') + 1);
  const path = decodeURIComponent(url.pathname);
  if (path.endsWith(`/${name}/-/${base}-${version}.tgz`)) {
    return { kind: 'registry', public: NPM_HOSTS.has(url.hostname) };
  }
  return fromUrl(resolved);
}

/** `name@version` with a scoped name's leading `@` kept: `@scope/pkg@1.0.0`. */
export function splitSpec(spec: string): { readonly name: string; readonly rest: string } {
  const at = spec.indexOf('@', 1);
  return at < 0 ? { name: spec, rest: '' } : { name: spec.slice(0, at), rest: spec.slice(at + 1) };
}

/** A lockfile Talos can't read is an engine error: the package manager would refuse it too. */
export function unreadable(path: string, error: unknown): EngineError {
  const text = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
  const reason = text.split('\n').find((line) => line.trim() !== '') ?? 'unknown format';
  return new EngineError(`${path} could not be read as a lockfile: ${reason.trim()}`);
}

export const isRegistry = (locked: Locked): boolean => locked.source.kind === 'registry';
export const isPublic = (locked: Locked): boolean =>
  locked.source.kind === 'registry' && locked.source.public;

/** `name@version`, the form `supply_chain.allow` keys take. */
export function spec(locked: Pick<Locked, 'name' | 'version'>): string {
  return `${locked.name}@${locked.version}`;
}

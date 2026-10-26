import { open } from 'node:fs/promises';
import { join, posix } from 'node:path';

/** The base config the PowerShell check writes; it is Talos's, so it is never analysed. */
export const PSSA_SETTINGS = 'PSScriptAnalyzerSettings.psd1';

/** Names that are never scripts, though they have no extension. */
const NOT_SCRIPTS = new Set([
  'AUTHORS',
  'Brewfile',
  'CHANGELOG',
  'CODEOWNERS',
  'COPYING',
  'Containerfile',
  'Dockerfile',
  'GNUmakefile',
  'Gemfile',
  'Jenkinsfile',
  'Justfile',
  'LICENCE',
  'LICENSE',
  'Makefile',
  'NOTICE',
  'OWNERS',
  'Pipfile',
  'Procfile',
  'README',
  'Rakefile',
  'VERSION',
  'Vagrantfile',
  'justfile',
  'makefile',
]);

/** The shells shellcheck understands, as a shebang names them. */
const SHELLS = new Set(['sh', 'bash', 'dash', 'ksh', 'busybox']);

/** Scripts named as shell scripts. */
export function namedShellScripts(files: readonly string[]): string[] {
  return files.filter((file) => /\.(sh|bash)$/.test(file));
}

/** Files with no extension that may be scripts, which their first line decides. */
export function shebangCandidates(files: readonly string[]): string[] {
  return files.filter((file) => {
    const name = posix.basename(file);
    return !name.includes('.') && !NOT_SCRIPTS.has(name);
  });
}

/** The shell a script's first line names, directly or through `env`, if shellcheck reads it. */
export function shellOf(firstLine: string): string | undefined {
  const match = /^#!\s*(\S.*)$/.exec(firstLine.trim());
  if (match?.[1] === undefined) return undefined;
  const words = match[1].split(/\s+/);
  const program = posix.basename(words[0] ?? '');
  const shell =
    program === 'env'
      ? words.slice(1).find((w) => !w.startsWith('-') && !w.includes('='))
      : program;
  return shell !== undefined && SHELLS.has(shell) ? shell : undefined;
}

/** A file's first line, or nothing when it can't be read. */
export async function firstLine(root: string, file: string): Promise<string> {
  try {
    const handle = await open(join(root, file), 'r');
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/** Every shell script: those named so, and the extensionless ones whose shebang names a shell. */
export async function shellScripts(root: string, files: readonly string[]): Promise<string[]> {
  const candidates = shebangCandidates(files);
  const lines = await Promise.all(candidates.map((file) => firstLine(root, file)));
  const found = candidates.filter((_, index) => shellOf(lines[index] ?? '') !== undefined);
  return [...namedShellScripts(files), ...found].sort((a, b) => a.localeCompare(b));
}

/** The names Docker and Podman look for: `Dockerfile`, Docker's `dockerfile`, `Containerfile`. */
const CONTAINER_FILE = /^(?:Dockerfile|dockerfile|Containerfile)$/;
/** One of them with a suffix: `Dockerfile.prod`, `Containerfile.dev`. */
const SUFFIXED = /^(?:Dockerfile|Containerfile)\../;
/** A name with one as its extension: `api.Dockerfile`, `api.dockerfile`, `api.Containerfile`. */
const EXTENSION = /.\.(?:Dockerfile|dockerfile|Containerfile|containerfile)$/;

/**
 * Whether a path is a Dockerfile or a Containerfile, named as Docker and Podman name them, in
 * their case: a source file such as `dockerfile.ts` is not one, nor is an ignore file such as
 * `Dockerfile.dockerignore`.
 */
export function isDockerfile(path: string): boolean {
  const name = posix.basename(path);
  if (name.endsWith('.dockerignore')) return false;
  return CONTAINER_FILE.test(name) || SUFFIXED.test(name) || EXTENSION.test(name);
}

export function dockerfiles(files: readonly string[]): string[] {
  return files.filter((file) => isDockerfile(file));
}

export function powershellFiles(files: readonly string[]): string[] {
  return files.filter((file) => /\.(ps1|psm1|psd1)$/i.test(file) && file !== PSSA_SETTINGS);
}

/** Workflows GitHub runs: YAML directly in `.github/workflows`. */
export function workflowFiles(files: readonly string[]): string[] {
  return files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
}

/** Action definitions anywhere in the repository. */
export function actionFiles(files: readonly string[]): string[] {
  return files.filter((file) => /(^|\/)action\.ya?ml$/.test(file));
}

export function dependabotFiles(files: readonly string[]): string[] {
  return files.filter((file) => /^\.github\/dependabot\.ya?ml$/.test(file));
}

/** Splits a list of files into runs short enough for any command line. */
export function batches<T>(items: readonly T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

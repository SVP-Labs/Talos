import type { Declaration } from './declaration.js';
import { dockerfileDeclarations } from './dockerfile.js';
import { TOOLS_LOCK, toolsLockDeclarations } from './tools-lock.js';
import {
  composerFile,
  goModFile,
  nodeVersionFile,
  pythonVersionFile,
  rustToolchainFile,
} from './version-files.js';
import { isDockerfile } from '../infra/files.js';

type Reader = (file: string, text: string) => Declaration[];

const BY_NAME: ReadonlyMap<string, Reader> = new Map<string, Reader>([
  ['.nvmrc', nodeVersionFile],
  ['.node-version', nodeVersionFile],
  ['.python-version', pythonVersionFile],
  ['rust-toolchain', rustToolchainFile],
  ['rust-toolchain.toml', rustToolchainFile],
  ['go.mod', goModFile],
  ['composer.json', composerFile],
]);

function readerFor(path: string): Reader | undefined {
  if (path === TOOLS_LOCK) return toolsLockDeclarations;
  const known = BY_NAME.get(path.split('/').at(-1) ?? '');
  if (known !== undefined) return known;
  return isDockerfile(path) ? dockerfileDeclarations : undefined;
}

/**
 * Whether a repository-relative path can declare a runtime: a Dockerfile (or Containerfile), a
 * version file, `composer.json`, or the root `tools.lock`.
 */
export function isDeclaringFile(path: string): boolean {
  return readerFor(path) !== undefined;
}

/**
 * Every runtime declaration in the files, by repository-relative path: each Dockerfile's `FROM`
 * lines, `.nvmrc`, `.node-version`, `.python-version`, `rust-toolchain(.toml)`, `go.mod`'s
 * `toolchain`, `composer.json`'s platform PHP (a minimum) and the runtimes in `tools.lock`.
 * Pure: the sweep passes files read through the API, the gate files from the checkout.
 */
export function declaredRuntimes(files: ReadonlyMap<string, string>): Declaration[] {
  return [...files].flatMap(([path, text]) => readerFor(path)?.(path, text) ?? []);
}

import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** A virtual environment's program, where the platform puts it. */
export function venvProgram(venv: string, name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(venv, 'Scripts', `${name}.exe`) : join(venv, 'bin', name);
}

/**
 * A relocatable environment, so it still runs after the rename that puts it in the cache, on
 * uv's own build of the pinned Python, never one the machine happens to have.
 */
export function venvArgs(python: string, venv: string): string[] {
  return [
    'venv',
    '--no-config',
    '--no-project',
    '--relocatable',
    '--managed-python',
    '--python',
    python,
    '--quiet',
    venv,
  ];
}

/** Installs only what the requirements pin, each distribution checked against its hash. */
export function installArgs(
  venv: string,
  requirements: string,
  platform: NodeJS.Platform,
): string[] {
  return [
    'pip',
    'install',
    '--no-config',
    '--require-hashes',
    '--only-binary',
    ':all:',
    '--python',
    venvProgram(venv, 'python', platform),
    '--quiet',
    '--requirement',
    requirements,
  ];
}

/** What a cached environment was built from: the Python and the exact requirements. */
export function pypiStamp(python: string, requirements: string): string {
  return createHash('sha256').update(`${python}\n${requirements}`).digest('hex');
}

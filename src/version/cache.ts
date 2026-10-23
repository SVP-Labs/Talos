import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Talos's cache directory on this machine: `TALOS_CACHE`, else the platform's user cache
 * (`%LOCALAPPDATA%\talos\cache`, `~/Library/Caches/talos`, `$XDG_CACHE_HOME/talos`).
 */
export function cacheRoot(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.TALOS_CACHE !== undefined && env.TALOS_CACHE !== '') return env.TALOS_CACHE;
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'talos', 'cache');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'talos');
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.cache'), 'talos');
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { type TalosConfig, talosConfigSchema } from './schema.js';

export const CONFIG_FILE = 'talos.yml';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Validates `talos.yml`'s text; every problem is listed with its path. */
export function parseConfig(text: string, source = CONFIG_FILE): TalosConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ConfigError(`${source} is not valid YAML: ${(error as Error).message}`);
  }
  const result = talosConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * The `talos.yml` at `root`. Without one, `fallback` stands in when given: the head's, for a
 * commit from before the repository adopted Talos, so its run judges the same components.
 */
export async function loadConfig(root: string, fallback?: TalosConfig): Promise<TalosConfig> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_FILE), 'utf8');
  } catch {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${CONFIG_FILE} not found in ${root}: run \`talos adopt\` first`);
  }
  return parseConfig(text);
}

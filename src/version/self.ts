import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The version of the Talos package this code was published as. */
export function ownVersion(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(text) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

/**
 * A digest of the code this runs from, every file of the build beside it: what tells one build of
 * a version from the next while Talos itself is changed.
 */
export async function ownBuild(): Promise<string> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0`).update(await readFile(join(root, file)));
  return hash.digest('hex').slice(0, 12);
}

/** Where Talos's shipped assets (templates, generated-file sources, prompts) live. */
export function assetsDir(): URL {
  return new URL('../../assets/', import.meta.url);
}

/**
 * The verification marker of the cache entry this code runs from (`<entry>/node_modules/
 * @svp-labs/talos/dist/version/self.js`), or `undefined` when it runs from anywhere else.
 */
export async function ownInstallMarker(): Promise<unknown> {
  try {
    const marker = new URL('../../../../../talos-verified.json', import.meta.url);
    return JSON.parse(await readFile(marker, 'utf8'));
  } catch {
    return undefined;
  }
}

const enginesSchema = z.object({
  engines: z.object({ node: z.string().default('*') }).default({ node: '*' }),
});

/** The Node range Talos's `package.json` asks for (`engines.node`). */
export function requiredNode(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = enginesSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data.engines.node : '*';
}

import { readFileSync } from 'node:fs';

/** The version of the Talos package this code was published as. */
export function ownVersion(): string {
  const text = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(text) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

/** Where Talos's shipped assets (templates, generated-file sources, prompts) live. */
export function assetsDir(): URL {
  return new URL('../../assets/', import.meta.url);
}

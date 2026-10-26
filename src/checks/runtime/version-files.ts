import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { type Declaration, lineAt, meaningfulLines, pinned } from './declaration.js';
import { isRelease, leadingRelease } from './versions.js';

/**
 * `.nvmrc` and `.node-version`: the first line that isn't a comment. `v22.12.0` and `22.12.0` pin
 * one release; `22`, `lts/*`, `node` and ranges float.
 */
export function nodeVersionFile(file: string, text: string): Declaration[] {
  const [first] = meaningfulLines(text);
  if (first === undefined) return [];
  const bare = first.text.replace(/^v(?=\d)/, '');
  const version = isRelease(bare) ? bare : undefined;
  return [pinned('node', { file, line: first.line }, first.text, version)];
}

const PYTHON_LINE = /^(?:cpython[-@]|python)?(\d\S*)$/i;

function pythonLine(
  file: string,
  entry: { readonly text: string; readonly line: number },
): Declaration[] {
  const place = { file, line: entry.line };
  if (entry.text.toLowerCase() === 'system') {
    return [pinned('python', place, entry.text, undefined)];
  }
  const match = PYTHON_LINE.exec(entry.text);
  if (match?.[1] === undefined) return [];
  return [pinned('python', place, entry.text, match[1].replace(/t$/, ''))];
}

/**
 * `.python-version`: one interpreter per line. CPython releases (`3.13.1`, `cpython@3.13`) and
 * `system` count; other interpreters are left alone.
 */
export function pythonVersionFile(file: string, text: string): Declaration[] {
  return meaningfulLines(text).flatMap((entry) => pythonLine(file, entry));
}

const toolchainSchema = z.object({ toolchain: z.object({ channel: z.string().optional() }) });

function channelOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^[\w.-]+$/.test(trimmed)) return trimmed;
  try {
    return toolchainSchema.safeParse(parseToml(text)).data?.toolchain.channel;
  } catch {
    return undefined;
  }
}

function firstLine(text: string, pattern: RegExp): number | undefined {
  const index = text.split(/\r?\n/).findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : index + 1;
}

/**
 * `rust-toolchain.toml`, or the legacy `rust-toolchain`: its channel. `1.83.0` pins a release;
 * `1.83`, `stable`, a dated nightly or no channel at all float.
 */
export function rustToolchainFile(file: string, text: string): Declaration[] {
  const channel = channelOf(text);
  const line = firstLine(text, /^\s*channel\s*=/) ?? firstLine(text, /\S/) ?? 1;
  const version = channel !== undefined && isRelease(channel) ? channel : undefined;
  return [pinned('rust', { file, line }, channel ?? 'no channel', version)];
}

/** `go.mod`'s `toolchain` line (`toolchain go1.23.4`); its `go` line is a language version. */
export function goModFile(file: string, text: string): Declaration[] {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*toolchain\s+\S/.test(line));
  const name = lines[index]?.trim().split(/\s+/)[1];
  if (name === undefined) return [];
  const release = /^go(\d\S*)$/.exec(name)?.[1];
  return [pinned('go', { file, line: index + 1 }, name, release)];
}

const composerSchema = z.object({
  config: z.object({ platform: z.object({ php: z.string() }) }),
});

/**
 * `composer.json`'s `config.platform.php`: the PHP that Composer resolves dependencies against,
 * often the lowest patch the project supports. It is a minimum, not the PHP the project ships.
 */
export function composerFile(file: string, text: string): Declaration[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const php = composerSchema.safeParse(parsed).data?.config.platform.php;
  const version = php === undefined ? undefined : leadingRelease(php.trim());
  if (php === undefined || version === undefined) return [];
  const platform = text.indexOf('"platform"');
  const key = text.slice(Math.max(platform, 0)).search(/"php"\s*:/);
  const line = lineAt(text, key < 0 ? Math.max(platform, 0) : Math.max(platform, 0) + key);
  return [{ runtime: 'php', file, line, written: php, version, exactness: 'minimum' }];
}

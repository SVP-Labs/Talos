import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import type { Bound } from './run.js';
import type { Finding } from '../../core/finding.js';

const FILES = ['rust-toolchain.toml', 'rust-toolchain'];

/** What the editor needs beside the compiler to show what the gate reports. */
const REQUIRED_COMPONENTS = ['clippy', 'rustfmt'];

const toolchainSchema = z.object({
  toolchain: z.object({
    channel: z.string().optional(),
    components: z.array(z.string()).optional(),
  }),
});

export type Pin = { readonly channel?: string; readonly components: readonly string[] };

/** A toolchain file: TOML with a `[toolchain]` table, or the legacy one-line channel. */
export function parseToolchain(text: string): Pin | undefined {
  const trimmed = text.trim();
  if (!trimmed.includes('[') && /^\S+$/.test(trimmed)) return { channel: trimmed, components: [] };
  try {
    const parsed = toolchainSchema.safeParse(parseToml(text));
    if (!parsed.success) return undefined;
    const { channel, components } = parsed.data.toolchain;
    return { ...(channel === undefined ? {} : { channel }), components: components ?? [] };
  } catch {
    return undefined;
  }
}

/** The toolchain file rustup reads for the component: its own, or the nearest above it. */
export function toolchainFile(root: string, tracked: ReadonlySet<string>): string | undefined {
  const parts = root === '.' ? [] : root.split('/');
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const dir = parts.slice(0, depth).join('/');
    const found = FILES.map((name) => posix.join(dir, name)).find((path) => tracked.has(path));
    if (found !== undefined) return found;
  }
  return undefined;
}

function lineOf(text: string, pattern: RegExp): number | undefined {
  const index = text.split(/\r?\n/).findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : index + 1;
}

const EXACT = /^\d+\.\d+\.\d+$/;

/** The pin's problems: a channel that isn't an exact release, an editor component missing. */
export function toolchainFindings(file: string, text: string): Finding[] {
  const pin = parseToolchain(text);
  const channelLine = lineOf(text, /channel|^\s*[\w.-]+\s*$/) ?? 1;
  if (pin?.channel === undefined || !EXACT.test(pin.channel)) {
    const what = pin?.channel === undefined ? 'pins no channel' : `pins "${pin.channel}"`;
    return [
      {
        rule: 'toolchain/unpinned',
        message: `${file} ${what}; pin an exact release, such as channel = "1.97.0".`,
        location: { file, line: channelLine },
      },
    ];
  }
  return REQUIRED_COMPONENTS.filter((name) => !pin.components.includes(name)).map((name) => ({
    rule: 'toolchain/missing',
    message: `${file} leaves out the ${name} component, which the editor needs to show what the gate reports.`,
    location: {
      file,
      line: lineOf(text, /^\s*components\s*=/) ?? lineOf(text, /^\s*\[toolchain\]/) ?? 1,
    },
  }));
}

/**
 * The component's Rust toolchain is pinned to an exact release with the editor's components, so
 * the editor, `talos check` and the gate run the same rustc, Clippy and rustfmt.
 */
export async function toolchain(ctx: Bound): Promise<Finding[]> {
  const file = toolchainFile(ctx.component.root, new Set(ctx.facts.files));
  if (file === undefined) {
    const where =
      ctx.component.root === '.'
        ? 'rust-toolchain.toml'
        : `${ctx.component.root}/rust-toolchain.toml`;
    return [
      {
        rule: 'toolchain/missing',
        message: `No ${where} pins the Rust toolchain; pin an exact release with clippy and rustfmt.`,
        key: `rust-toolchain ${ctx.component.root}`,
      },
    ];
  }
  return toolchainFindings(file, await readFile(join(ctx.root, file), 'utf8'));
}

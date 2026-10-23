import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { readRustflags } from './cargo-config.js';
import { CLIPPY_BASE, CLIPPY_SETTINGS, RUSTFMT_BASE, RUSTFMT_SETTINGS } from './configs.js';
import { workspace } from './metadata.js';
import { relativeTo } from './paths.js';
import { type Bound, failed, runIn } from './run.js';
import {
  lintTableFindings,
  macheteFindings,
  rustflagFindings,
  shadowingFindings,
  tableAt,
} from './strength-rules.js';
import { EngineError } from '../../core/check.js';
import { componentDir, inComponent } from '../../core/component.js';
import type { Finding } from '../../core/finding.js';
import { underRoot } from '../../repo/facts.js';

type Parsed = { readonly file: string; readonly text: string; readonly data: unknown };

async function readToml(ctx: Bound, file: string): Promise<Parsed | undefined> {
  const text = await readFile(join(ctx.root, file), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return { file, text, data: parseToml(text) };
  } catch {
    return { file, text, data: {} };
  }
}

/** rustfmt's own defaults, as the pinned rustfmt prints them, under Talos's settings. */
async function rustfmtBase(ctx: Bound): Promise<Record<string, unknown>> {
  const result = await runIn(ctx, 'rustfmt', ['--print-config', 'default']);
  if (result.code !== 0) throw failed('rustfmt --print-config default', result);
  try {
    return { ...parseToml(result.stdout), ...RUSTFMT_SETTINGS };
  } catch {
    throw new EngineError('rustfmt --print-config default printed no readable TOML');
  }
}

/** Tracked files of these names in the component, but not Talos's own base at its root. */
function shadows(ctx: Bound, names: readonly string[], base: string): string[] {
  const root = ctx.component.root;
  return underRoot(ctx.facts.files, root).filter((file) => {
    const local = inComponent(root, file);
    return local !== undefined && local !== base && names.includes(posix.basename(file));
  });
}

async function shadowing(ctx: Bound): Promise<Finding[]> {
  const findings: Finding[] = [];
  const rustfmt = shadows(ctx, ['rustfmt.toml', '.rustfmt.toml'], RUSTFMT_BASE);
  const clippy = shadows(ctx, ['clippy.toml', '.clippy.toml'], CLIPPY_BASE);
  const defaults = rustfmt.length > 0 ? await rustfmtBase(ctx) : {};
  for (const [files, base, tool] of [
    [rustfmt, defaults, 'rustfmt'],
    [clippy, CLIPPY_SETTINGS, 'clippy'],
  ] as const) {
    for (const file of files) {
      const parsed = await readToml(ctx, file);
      const settings = tableAt(parsed?.data, []) ?? {};
      findings.push(...shadowingFindings({ file, text: parsed?.text ?? '' }, settings, base, tool));
    }
  }
  return findings;
}

async function manifests(ctx: Bound): Promise<Finding[]> {
  const ws = await workspace(ctx);
  const dir = componentDir(ctx);
  const repo = (local: string): string => relativeTo(ctx.root, dir, local);
  const root = await readToml(ctx, relativeTo(ctx.root, ws.root, 'Cargo.toml'));
  const findings: Finding[] = [];
  let usesWorkspace = false;
  for (const pkg of ws.packages) {
    const parsed = await readToml(ctx, repo(pkg.manifest));
    if (parsed === undefined) continue;
    const lints = tableAt(parsed.data, ['lints']);
    if (lints?.workspace === true) usesWorkspace = true;
    else findings.push(...lintTableFindings(parsed, 'lints', lints));
    if (parsed.file !== root?.file) findings.push(...macheteFindings(parsed, parsed.data));
  }
  if (root !== undefined) {
    if (usesWorkspace) {
      const table = tableAt(root.data, ['workspace', 'lints']);
      findings.push(...lintTableFindings(root, 'workspace.lints', table));
    }
    findings.push(...macheteFindings(root, root.data));
  }
  return findings;
}

async function rustflags(ctx: Bound): Promise<Finding[]> {
  const settings = await readRustflags(ctx);
  const texts = new Map<string, string>();
  for (const file of new Set(settings.map((s) => s.file))) {
    texts.set(file, await readFile(join(ctx.root, file), 'utf8').catch(() => ''));
  }
  return rustflagFindings(settings, texts);
}

/**
 * What would make the editor, or the gate, lint more loosely than Talos's base: lint levels in
 * the Cargo.toml files (which the editor shows; the gate passes its own after them), rustfmt and
 * Clippy files the gate ignores but the editor reads, `rustflags` that lower lint levels, and
 * cargo-machete's ignore lists.
 */
export async function strength(ctx: Bound): Promise<Finding[]> {
  const parts = await Promise.all([shadowing(ctx), manifests(ctx), rustflags(ctx)]);
  const seen = new Set<string>();
  return parts.flat().filter((finding) => {
    const id = `${finding.rule} ${finding.key ?? ''}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

import { posix } from 'node:path';
import { z } from 'zod';
import type { Seed } from './python.js';
import type { Reader } from './scaffold.js';
import {
  joinToml,
  parsedToml,
  sameToml,
  spaced,
  splitToml,
  type TomlSection,
} from './toml-text.js';
import type { ExceptionEntry } from '../config/schema.js';
import { carriesGeneratedMarker } from '../configs/header.js';

/**
 * A repository's own security tool settings, moved to where Talos keeps them: an
 * `osv-scanner.toml`'s vulnerability exceptions into `talos.yml`'s `supply_chain.exceptions`
 * (from which Talos renders the scanner's file) and its licence ignores into `licences`, and a
 * `.gitleaks.toml`'s own rules into `.gitleaks.project.toml`, which the generated base extends.
 */

/** What moves into `talos.yml`. */
export type Additions = {
  readonly exceptions: Readonly<Record<string, ExceptionEntry>>;
  readonly licences: Readonly<Record<string, string>>;
};

export type SecurityMigration = {
  readonly additions: Additions;
  /** `osv-scanner.toml` files everything moved out of. */
  readonly moved: readonly string[];
  /** The gitleaks extension's text, from its initial or current text. */
  readonly gitleaks?: Seed;
  readonly next: readonly string[];
};

const OSV = 'osv-scanner.toml';
export const GITLEAKS = '.gitleaks.toml';

const osvSchema = z.looseObject({
  IgnoredVulns: z
    .array(
      z.looseObject({
        id: z.string(),
        ignoreUntil: z.unknown().optional(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  PackageOverrides: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        license: z.looseObject({ ignore: z.boolean().optional() }).optional(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
});

type Osv = z.infer<typeof osvSchema>;

function dateOf(value: unknown): string | undefined {
  if (value instanceof Date) return /^\d{4}-\d{2}-\d{2}/.exec(value.toISOString())?.[0];
  return typeof value === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] : undefined;
}

const DEPRECATED_GNU = /^(A?GPL|LGPL|GFDL)-(\d\.\d)(\+?)$/;

/** An SPDX id as deps.dev reports it: the deprecated GNU ids say `-only` or `-or-later`. */
export function spdx(id: string): string {
  const gnu = DEPRECATED_GNU.exec(id);
  if (gnu === null) return id;
  return `${gnu[1] ?? ''}-${gnu[2] ?? ''}-${gnu[3] === '+' ? 'or-later' : 'only'}`;
}

/** The licence a reason starts with (`LGPL-3.0, a lint plugin…`), and the rest of it. */
export function licenceOf(reason: string): { licence: string; rest: string } | undefined {
  const cut = reason.search(/[,:;]/);
  if (cut === -1) return undefined;
  const head = reason.slice(0, cut).trim();
  if (!/^[A-Za-z][\w.+-]*$/.test(head) || !/\d/.test(head)) return undefined;
  return { licence: spdx(head), rest: reason.slice(cut + 1).trim() };
}

type Collected = {
  exceptions: Record<string, ExceptionEntry>;
  licences: Record<string, string[]>;
  next: string[];
};

function collectVulns(file: string, osv: Osv, into: Collected): boolean {
  let whole = true;
  for (const vuln of osv.IgnoredVulns) {
    const expires = dateOf(vuln.ignoreUntil);
    const reason = vuln.reason?.trim() ?? '';
    if (expires === undefined || reason === '') {
      into.next.push(
        `${file} ignores ${vuln.id} without a reason or an expiry: give it both under ` +
          "talos.yml's supply_chain.exceptions",
      );
      whole = false;
    } else {
      into.exceptions[vuln.id] ??= { reason, expires };
    }
  }
  return whole;
}

function collectOverrides(file: string, osv: Osv, into: Collected): boolean {
  let whole = true;
  for (const override of osv.PackageOverrides) {
    const name = override.name ?? 'a package';
    const found = override.license?.ignore === true ? licenceOf(override.reason ?? '') : undefined;
    if (found === undefined) {
      into.next.push(
        `${file} overrides ${name}, which talos.yml can't say: add its licence under licences ` +
          'with a reason, or drop it',
      );
      whole = false;
      continue;
    }
    const why = found.rest === '' ? name : `${name}: ${found.rest}`;
    into.licences[found.licence] = [...(into.licences[found.licence] ?? []), why];
  }
  return whole;
}

function osvMigration(files: readonly string[], read: Reader, into: Collected): string[] {
  const moved: string[] = [];
  for (const file of files.filter((f) => posix.basename(f) === OSV)) {
    const text = read(file);
    if (text === undefined || carriesGeneratedMarker(text)) continue;
    const parsed = osvSchema.safeParse(parsedToml(text));
    if (!parsed.success) {
      into.next.push(`${file} can't be read: move its exceptions into talos.yml by hand`);
      continue;
    }
    const vulns = collectVulns(file, parsed.data, into);
    const overrides = collectOverrides(file, parsed.data, into);
    if (vulns && overrides) moved.push(file);
  }
  return moved;
}

const gitleaksSchema = z.looseObject({ extend: z.looseObject({}).optional() });

const rootOf = (sections: readonly TomlSection[]) => sections.filter((s) => s.name === undefined);
const tablesOf = (sections: readonly TomlSection[]) => sections.filter((s) => s.name !== undefined);

/** The `[extend]` table without its header and settings: only the comments above it stay. */
function extendComments(section: TomlSection): TomlSection {
  const header = section.lines.findIndex((line, i) => section.top[i] && /^\s*\[/.test(line));
  const lines = header <= 0 ? [] : [...section.lines.slice(0, header), ''];
  return { name: undefined, array: false, lines, top: lines.map(() => true) };
}

function gitleaksSeed(text: string): { seed?: Seed; note?: string } {
  const raw = parsedToml(text);
  const parsed = gitleaksSchema.safeParse(raw);
  if (raw === undefined || !parsed.success) {
    return { note: `${GITLEAKS} can't be read: move its own rules by hand` };
  }
  const { extend: _ours, ...own } = raw;
  if (Object.keys(own).length === 0) return {};
  const sections = splitToml(text);
  const kept = sections.flatMap((s) => (s.name === 'extend' ? [extendComments(s)] : [s]));
  const seed: Seed = (current) => {
    const into = splitToml(current);
    return joinToml(
      spaced([...rootOf(into), ...rootOf(kept), ...tablesOf(into), ...tablesOf(kept)]),
    );
  };
  const result = parsedToml(seed('[extend]\nuseDefault = true\n'));
  const { extend: _, ...moved } = result ?? {};
  if (result === undefined || !sameToml(moved, own)) {
    return { note: `${GITLEAKS}'s own rules could not be moved safely: move them by hand` };
  }
  const extra = Object.keys(parsed.data.extend ?? {}).filter((key) => key !== 'useDefault');
  return {
    seed,
    ...(extra.length === 0
      ? {}
      : {
          note: `${GITLEAKS}'s [extend] ${extra.join(', ')} did not move: the base keeps every default rule`,
        }),
  };
}

/** Everything a repository's own security settings hold that Talos keeps elsewhere. */
export function securityMigration(files: readonly string[], read: Reader): SecurityMigration {
  const into: Collected = { exceptions: {}, licences: {}, next: [] };
  const moved = osvMigration(files, read, into);
  const gitleaksText = files.includes(GITLEAKS) ? read(GITLEAKS) : undefined;
  const gitleaks =
    gitleaksText === undefined || carriesGeneratedMarker(gitleaksText)
      ? {}
      : gitleaksSeed(gitleaksText);
  if (gitleaks.note !== undefined) into.next.push(gitleaks.note);
  const licences = Object.fromEntries(
    Object.entries(into.licences).map(([licence, why]) => [licence, why.join('; ')]),
  );
  return {
    additions: { exceptions: into.exceptions, licences },
    moved,
    ...(gitleaks.seed === undefined ? {} : { gitleaks: gitleaks.seed }),
    next: into.next,
  };
}

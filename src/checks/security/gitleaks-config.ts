import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { generatedHeader } from '../../configs/header.js';
import type { Generated } from '../../core/pack.js';

export const GITLEAKS_BASE = '.gitleaks.toml';
export const GITLEAKS_PROJECT = '.gitleaks.project.toml';

/**
 * gitleaks extends one file at a time, and only to two levels, so the base extends the
 * project's file and the project's file extends gitleaks' defaults.
 */
export function renderGitleaksBase(version: string): string {
  return [
    generatedHeader('#', version, GITLEAKS_PROJECT).trimEnd(),
    "# gitleaks' default rules and the project's own, through the project's file.",
    'title = "Talos"',
    '',
    '[extend]',
    `path = "${GITLEAKS_PROJECT}"`,
    '',
  ].join('\n');
}

const PROJECT_INITIAL = [
  `# This project's additions to ${GITLEAKS_BASE}: rules of its own, each with its own allowlist.`,
  "# It keeps gitleaks' default rules: it disables none and adds no global allowlist.",
  '[extend]',
  'useDefault = true',
  '',
].join('\n');

export const gitleaksBase: Generated = {
  path: GITLEAKS_BASE,
  scope: 'repo',
  applies: () => true,
  render: (ctx) => renderGitleaksBase(ctx.version),
  extension: { path: GITLEAKS_PROJECT, initial: () => PROJECT_INITIAL },
};

const rule = z.looseObject({ id: z.string() });

const project = z.looseObject({
  extend: z
    .looseObject({
      useDefault: z.boolean().optional(),
      path: z.string().optional(),
      url: z.string().optional(),
      disabledRules: z.array(z.string()).default([]),
    })
    .optional(),
  allowlist: z.unknown().optional(),
  allowlists: z.unknown().optional(),
  rules: z.array(rule).default([]),
});

export type ProjectRule = z.infer<typeof rule>;

/** One way the project's file weakens gitleaks: what it is about, and how. */
export type Weakening = { readonly key: string; readonly how: string };

export type GitleaksProject = {
  readonly rules: readonly ProjectRule[];
  readonly weakenings: readonly Weakening[];
};

function extendWeakenings(extend: z.infer<typeof project>['extend']): Weakening[] {
  const found: Weakening[] = [];
  if (extend?.useDefault !== true) {
    found.push({
      key: 'useDefault',
      how: "drops gitleaks' default rules (keep useDefault = true)",
    });
  }
  if (extend?.path !== undefined || extend?.url !== undefined) {
    found.push({ key: 'extend', how: "extends another file in place of gitleaks' defaults" });
  }
  for (const id of extend?.disabledRules ?? []) {
    found.push({ key: `disabled ${id}`, how: `disables gitleaks' rule ${id}` });
  }
  return found;
}

/**
 * The project's rules, and what in the file weakens gitleaks: dropping or disabling its default
 * rules, extending something else, or an allowlist outside the project's own rules (a global
 * one, or one aimed at default rules through `targetRules`).
 */
export function readGitleaksProject(text: string): GitleaksProject {
  let parsed: z.infer<typeof project>;
  try {
    parsed = project.parse(parse(text));
  } catch {
    return {
      rules: [],
      weakenings: [{ key: 'unreadable', how: 'cannot be read as a gitleaks configuration' }],
    };
  }
  const weakenings = extendWeakenings(parsed.extend);
  if (parsed.allowlist !== undefined || parsed.allowlists !== undefined) {
    weakenings.push({
      key: 'global allowlist',
      how: "adds an allowlist outside its own rules, which gitleaks' rules would honour too",
    });
  }
  return { rules: parsed.rules, weakenings };
}

/** A project rule that reuses a default rule's id replaces that rule's pattern. */
export function redefinitions(ids: ReadonlySet<string>): Weakening[] {
  return [...ids].map((id) => ({
    key: `redefines ${id}`,
    how: `redefines gitleaks' rule ${id} (give the project's rule an id of its own)`,
  }));
}

/**
 * The configuration the gate scans with: gitleaks' defaults, whatever the project's file says
 * about them, plus the project's own rules that redefine none of them.
 */
export function scanConfig(rules: readonly ProjectRule[]): string {
  return stringify({ title: 'Talos', extend: { useDefault: true }, rules });
}

/**
 * A configuration gitleaks loads only when `id` names one of its default rules: an allowlist
 * aimed at a rule that doesn't exist stops it.
 */
export function probeConfig(id: string): string {
  return stringify({
    extend: { useDefault: true },
    allowlists: [{ description: 'probe', targetRules: [id], regexes: ['^$'] }],
  });
}

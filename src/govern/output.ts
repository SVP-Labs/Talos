import type { StepResult } from './steps.js';

/** Agent-facing output stays small: lists cut at 20 with their total, messages at 200. */
const MAX_LISTED = 20;
const MAX_MESSAGE = 200;

export function clip(text: string, max = MAX_MESSAGE): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export type Capped<T> = { readonly items: readonly T[]; readonly total: number };

export function capped<T>(items: readonly T[], max = MAX_LISTED): Capped<T> {
  return { items: items.slice(0, max), total: items.length };
}

/** The results with each detail clipped, capped, plus the manual steps on their own. */
export function stepsOutput(results: readonly StepResult[]): {
  readonly ok: boolean;
  readonly steps: Capped<StepResult>;
  readonly manual: Capped<string>;
} {
  return {
    ok: results.every((r) => r.status !== 'failed' && r.status !== 'skipped'),
    steps: capped(results.map((r) => ({ ...r, detail: clip(r.detail) }))),
    manual: capped(results.filter((r) => r.status === 'manual').map((r) => clip(r.detail))),
  };
}

const MARK: Readonly<Record<StepResult['status'], string>> = {
  ok: '✓',
  changed: '+',
  planned: '~',
  manual: '!',
  failed: '✗',
  skipped: '-',
};

/** One line per step for a person: `+ ruleset:talos-merge-queue  create talos-merge-queue`. */
export function stepsText(title: string, results: readonly StepResult[]): string {
  const width = Math.max(0, ...results.map((r) => r.id.length));
  const lines = results.map((r) => `${MARK[r.status]} ${r.id.padEnd(width)}  ${r.detail}`);
  return `${title}\n${lines.join('\n')}\n`;
}

import { readFileSync } from 'node:fs';
import type { TalosConfig } from '../config/schema.js';
import { GENERATED_MARKER } from '../configs/header.js';
import { assetsDir } from '../version/self.js';

/**
 * `CLAUDE.md` is instructions only: Talos's block between these markers, rendered from
 * `assets/claude/kit-block.md`, then the project's own block, capped.
 */
export const KIT_BEGIN = '<!-- talos:begin -->';
export const KIT_END = '<!-- talos:end -->';
const KIT_NOTE = `<!-- ${GENERATED_MARKER}: talos adopt rewrites this block; add yours below it. -->`;
/** Non-blank lines the project's own block may hold. */
export const PROJECT_BLOCK_CAP = 60;
const TALOS_DOCS = 'https://github.com/SVP-Labs/Talos/blob/main/';

type KitConfig = Pick<TalosConfig, 'name' | 'prefix' | 'docs'>;

/** The kit block's template as this Talos ships it. */
export function loadKitTemplate(): string {
  return readFileSync(new URL('claude/kit-block.md', assetsDir()), 'utf8');
}

/** The kit block for a project, markers included, from the template's `{{placeholders}}`. */
export function kitBlock(template: string, config: KitConfig): string {
  const values: Readonly<Record<string, string>> = {
    name: config.name,
    prefix: config.prefix,
    briefs: config.docs.briefs,
    glossary: config.docs.glossary,
    engineering: `${TALOS_DOCS}ENGINEERING.md`,
    agents: `${TALOS_DOCS}docs/agents.md`,
  };
  const body = template.replaceAll(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
  return [KIT_BEGIN, KIT_NOTE, '', body.trim(), '', KIT_END].join('\n');
}

/**
 * `CLAUDE.md` with the kit block written in: replaced where it is, otherwise put first, so a
 * rerun leaves the project's own instructions as they were.
 */
export function renderClaudeMd(
  existing: string | undefined,
  ctx: { readonly config: KitConfig },
  template: string = loadKitTemplate(),
): string {
  const block = kitBlock(template, ctx.config);
  if (existing === undefined || existing.trim() === '') return `${block}\n`;
  const start = existing.indexOf(KIT_BEGIN);
  const end = existing.indexOf(KIT_END, start);
  if (start !== -1 && end !== -1) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + KIT_END.length)}`;
  }
  return `${block}\n\n${existing.trimStart()}`;
}

/** 1-based, inclusive. */
type LineSpan = { readonly line: number; readonly endLine: number };

export type ClaudeBlocks = {
  /** The kit block's lines, markers included, when both markers are there in order. */
  readonly kit?: LineSpan & { readonly text: string };
  /** The project's own lines around the kit block, without blank lines at either end. */
  readonly project?: LineSpan & { readonly lines: number };
};

function projectSpan(lines: readonly string[], kit: LineSpan | undefined): ClaudeBlocks['project'] {
  const inKit = (index: number): boolean =>
    kit !== undefined && index + 1 >= kit.line && index + 1 <= kit.endLine;
  const own = lines.flatMap((line, index) => (!inKit(index) && line.trim() !== '' ? [index] : []));
  const first = own[0];
  const last = own.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return { line: first + 1, endLine: last + 1, lines: own.length };
}

/** Splits `CLAUDE.md` into the kit block and the project's own block. */
export function claudeBlocks(text: string): ClaudeBlocks {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const begin = lines.findIndex((line) => line.trim() === KIT_BEGIN);
  const end =
    begin === -1 ? -1 : lines.findIndex((line, i) => i > begin && line.trim() === KIT_END);
  const kit =
    end === -1
      ? undefined
      : { line: begin + 1, endLine: end + 1, text: lines.slice(begin, end + 1).join('\n') };
  const project = projectSpan(lines, kit);
  return { ...(kit === undefined ? {} : { kit }), ...(project === undefined ? {} : { project }) };
}

function normalise(block: string): string {
  return block
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .map((line) => (line.startsWith(`<!-- ${GENERATED_MARKER}`) ? KIT_NOTE : line))
    .join('\n')
    .trim();
}

/** Whether a committed kit block says what the rendering says; its generated note may differ. */
export function sameKitBlock(committed: string, rendered: string): boolean {
  return normalise(committed) === normalise(rendered);
}

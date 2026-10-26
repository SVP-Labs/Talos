import { comparedFiles, JSCPD_FORMATS, NOT_COMPARED } from './code-files.js';
import { generatedJsonNote } from '../../configs/header.js';
import { renderFlatJson } from '../../configs/json.js';
import type { Generated } from '../../core/pack.js';

const JSCPD_CONFIG = '.jscpd.json';

/** The smallest repetition that counts: 50 tokens spanning at least 5 lines. */
const MIN_TOKENS = 50;
const MIN_LINES = 5;

function trimSlashes(entry: string): string {
  let end = entry.length;
  while (end > 0 && entry[end - 1] === '/') end -= 1;
  return entry.slice(0, end);
}

/** `talos.yml`'s `exclude` entries as globs: each names a file, a directory or a glob. */
export function excludeGlobs(exclude: readonly string[]): string[] {
  return exclude.flatMap((entry) => {
    const trimmed = trimSlashes(entry);
    return [trimmed, `${trimmed}/**`];
  });
}

/**
 * The base for editors and a local `jscpd` run, with the gate's thresholds and what it leaves
 * out. jscpd reads one config file and extends none, and the only thing a project could want to
 * change is what is compared, which `talos.yml`'s `exclude` already says; so there is no
 * extension file.
 */
export function renderJscpdBase(version: string, exclude: readonly string[]): string {
  return renderFlatJson({
    '//': generatedJsonNote(version),
    minTokens: MIN_TOKENS,
    minLines: MIN_LINES,
    threshold: 0,
    gitignore: true,
    absolute: false,
    reporters: ['console'],
    format: JSCPD_FORMATS,
    ignore: ['**/node_modules/**', ...NOT_COMPARED, ...excludeGlobs(exclude)],
  });
}

/** What the gate passes jscpd: the thresholds and every file to compare, by absolute path. */
export function gateSettings(paths: readonly string[]): string {
  return JSON.stringify({ minTokens: MIN_TOKENS, minLines: MIN_LINES, path: paths });
}

export const jscpdBase: Generated = {
  path: JSCPD_CONFIG,
  scope: 'repo',
  applies: (ctx) => comparedFiles(ctx.facts).length > 0,
  render: (ctx) => renderJscpdBase(ctx.version, ctx.config.exclude),
};

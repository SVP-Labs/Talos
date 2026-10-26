import { type ApplyContext, type Check, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { componentFiles, isJavaScript, isTooling } from '../files.js';

/** JavaScript sources in the component; tool configs (which tools want as JavaScript) aside. */
export function javascriptSources(files: readonly string[]): string[] {
  return files.filter((file) => isJavaScript(file) && !isTooling(file));
}

/**
 * Each JavaScript source is a finding at its first line: a new file is new at head and fails,
 * an existing one is debt until it is migrated (type-checked through `checkJs` meanwhile).
 */
export function javascriptFindings(files: readonly string[]): Finding[] {
  return javascriptSources(files).map((file) => ({
    rule: 'ts/javascript',
    message: `${file} is JavaScript; write it in TypeScript.`,
    location: { file, line: 1 },
  }));
}

function sources(ctx: ApplyContext): string[] {
  return javascriptSources(componentFiles(ctx));
}

export const javascriptCheck: Check = {
  id: 'ts/javascript',
  tier: 'commit',
  scope: 'component',
  langs: ['ts'],
  title: 'No new JavaScript',
  applies: (ctx) => (sources(ctx).length > 0 ? APPLIES : skip('no JavaScript sources')),
  run: (ctx) => Promise.resolve(javascriptFindings(componentFiles(ctx))),
};

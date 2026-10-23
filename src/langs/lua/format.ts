import { STYLUA_CONFIG } from './configs.js';
import { componentDir, fromTool, luaFiles } from './paths.js';
import type { Bound } from './run.js';
import { failed } from './run.js';
import { parseStylua } from './stylua.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

/** Which lines StyLua would rewrite, as a sentence. */
export function rewriteMessage(line: number, endLine: number): string {
  const which = line === endLine ? `line ${line}` : `lines ${line} to ${endLine}`;
  return `StyLua would rewrite ${which}.`;
}

/**
 * `stylua --check` with the generated config, which a nested `stylua.toml` or an
 * `.editorconfig` can't replace: one finding per stretch StyLua would rewrite.
 */
export async function format(ctx: Bound): Promise<Finding[]> {
  const files = luaFiles(ctx);
  if (files.length === 0) throw new EngineError('lua/format ran on a component with no Lua files');
  const stylua = await ctx.tools.path('stylua');
  const args = [
    '--check',
    '--output-format',
    'Json',
    '--config-path',
    STYLUA_CONFIG,
    '--no-editorconfig',
    '--color',
    'Never',
    '--',
    ...files,
  ];
  const result = await ctx.exec(stylua, args, { cwd: componentDir(ctx) });
  if (result.code > 1) throw failed('stylua --check', result);
  return parseStylua(result.stdout).map((u) => ({
    rule: 'stylua/format',
    message: rewriteMessage(u.line, u.endLine),
    location: { file: fromTool(ctx, u.file), line: u.line, endLine: u.endLine },
  }));
}

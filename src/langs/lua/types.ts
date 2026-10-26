import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { type CheckedFile, diagnosticFindings, parseCheck, relativeTo, uriPath } from './luals.js';
import { componentDir, fromTool, luaFiles } from './paths.js';
import { type Bound, failed } from './run.js';
import type { Finding } from '../../core/finding.js';

async function check(ctx: Bound, dir: string): Promise<string> {
  const luals = await ctx.tools.path('lua-language-server');
  const out = join(ctx.scratch, 'check.json');
  const args = [
    `--check=${dir}`,
    '--checklevel=Hint',
    '--check_format=json',
    `--check_out_path=${out}`,
    `--logpath=${join(ctx.scratch, 'log')}`,
    `--metapath=${join(ctx.scratch, 'meta')}`,
  ];
  const result = await ctx.exec(luals, args, { cwd: dir, env: { NO_COLOR: '1' } });
  const text = await readFile(out, 'utf8').catch(() => undefined);
  if (text === undefined || result.code > 1) throw failed('lua-language-server --check', result);
  return text;
}

/**
 * `lua-language-server --check` over the component with the generated `.luarc.json`, every
 * diagnostic down to hints. LuaLS reads the whole directory, so only the component's tracked
 * Lua files are reported. Its URIs are canonical paths, so the directory is resolved first.
 */
export async function types(ctx: Bound): Promise<Finding[]> {
  const dir = await realpath(componentDir(ctx));
  const wanted = new Set(luaFiles(ctx));
  const files: CheckedFile[] = [];
  for (const [uri, diagnostics] of parseCheck(await check(ctx, dir))) {
    const path = uriPath(uri);
    const file = path === undefined ? undefined : relativeTo(dir, path, ctx.os === 'windows');
    if (file === undefined || !wanted.has(file)) continue;
    files.push({ file, repoFile: fromTool(ctx, file), diagnostics });
  }
  return diagnosticFindings(files);
}

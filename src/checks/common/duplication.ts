import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { comparedFiles } from './code-files.js';
import { gateSettings } from './jscpd-config.js';
import { cloneFindings } from './jscpd-report.js';
import { ownTexts } from './texts.js';
import { APPLIES, type Check, type CheckContext, EngineError, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { ExecResult } from '../../exec/exec.js';

const resolveFromTalos = createRequire(import.meta.url);

const manifest = z.object({
  bin: z.union([z.string(), z.object({ jscpd: z.string() })]),
});

/** jscpd ships with Talos as a dependency: its launcher script, run with Talos's own Node. */
async function jscpdScript(): Promise<string> {
  let path: string;
  try {
    path = resolveFromTalos.resolve('jscpd/package.json');
  } catch {
    throw new EngineError("jscpd is missing from Talos's installation");
  }
  const text = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = manifest.safeParse(raw);
  if (!parsed.success) throw new EngineError("jscpd's package.json names no program");
  const bin = typeof parsed.data.bin === 'string' ? parsed.data.bin : parsed.data.bin.jscpd;
  return join(dirname(path), bin);
}

function tail(result: ExecResult): string {
  return `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-15).join('\n');
}

/**
 * Runs jscpd over the files, absolute, listed in its config rather than on its command line,
 * which a large repository would overflow. jscpd reads an empty list as the working directory,
 * so the caller never passes one.
 */
async function runJscpd(
  ctx: CheckContext,
  root: string,
  files: readonly string[],
): Promise<ExecResult> {
  const config = join(ctx.scratch, 'jscpd.json');
  await writeFile(config, gateSettings(files.map((file) => join(root, file))));
  const args = [
    await jscpdScript(),
    '--config',
    config,
    '--reporters',
    'json',
    '--output',
    ctx.scratch,
    '--absolute',
    '--silent',
    '--no-gitignore',
    '--no-colors',
    '--no-tips',
  ];
  try {
    return await ctx.exec(process.execPath, args, {
      cwd: root,
      env: { NO_COLOR: '1', JSCPD_NO_TIPS: '1' },
    });
  } catch (error) {
    throw new EngineError(`jscpd could not run: ${error instanceof Error ? error.message : ''}`);
  }
}

/** jscpd over every language's code at once, tests and `exclude` left out. */
async function duplication(ctx: CheckContext): Promise<Finding[]> {
  const files = (await ownTexts(ctx.root, comparedFiles(ctx.facts))).map((text) => text.file);
  if (files.length < 1) return [];
  // jscpd reports paths with links resolved, so the checkout's own path is resolved too.
  const root = await realpath(ctx.root);
  const result = await runJscpd(ctx, root, files);
  if (result.code !== 0) {
    throw new EngineError(`jscpd exited ${result.code}:\n${tail(result)}`);
  }
  const report = await readFile(join(ctx.scratch, 'jscpd-report.json'), 'utf8').catch(
    () => undefined,
  );
  if (report === undefined) throw new EngineError(`jscpd wrote no report:\n${tail(result)}`);
  return cloneFindings(report, root);
}

export const duplicationCheck: Check = {
  id: 'common/duplication',
  tier: 'head',
  scope: 'repo',
  title: 'jscpd: no repeated code of 50 tokens or 5 lines',
  applies: (ctx) =>
    comparedFiles(ctx.facts).length > 0 ? APPLIES : skip('the repository has no code to compare'),
  run: duplication,
};

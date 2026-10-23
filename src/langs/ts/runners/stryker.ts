import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CheckContext, EngineError } from '../../../core/check.js';
import type { MutationRunner, Report } from '../../../quality/index.js';
import { STRYKER_BASE } from '../configs/stryker.js';
import { inComponent, rootOf } from '../files.js';
import { componentDir, exists, nodeTool, runTool, tail } from '../node.js';

/**
 * A config in scratch that takes the component's rendered base and narrows it to the given
 * files, with only the JSON report, written into scratch.
 */
export function strykerWrapper(base: string, files: readonly string[], report: string): string {
  return `import base from ${JSON.stringify(base)};

export default {
  ...base,
  mutate: ${JSON.stringify(files)},
  reporters: ['json'],
  jsonReporter: { fileName: ${JSON.stringify(report)} },
  incremental: false,
};
`;
}

/** Stryker's report format with no file in it, for a run with nothing to mutate. */
const EMPTY_REPORT = '{"schemaVersion":"1.0","thresholds":{"high":80,"low":60},"files":{}}\n';

/**
 * Stryker through Vitest, on the component's files among those given (repository-relative); a
 * file the change deleted has nothing left to mutate.
 */
export const strykerRunner: MutationRunner = {
  async run(ctx: CheckContext, files: readonly string[]): Promise<Report & { format: 'stryker' }> {
    const root = rootOf(ctx.component);
    const dir = componentDir(ctx);
    const here = files.filter((file) => root === '.' || file.startsWith(`${root}/`));
    const present = await Promise.all(here.map((file) => exists(join(ctx.root, file))));
    const mine = here.filter((_, index) => present[index]).map((file) => inComponent(root, file));
    const report = join(ctx.scratch, 'mutation.json');
    if (mine.length === 0) {
      await writeFile(report, EMPTY_REPORT);
      return { path: report, base: dir, format: 'stryker' };
    }
    const config = join(ctx.scratch, 'stryker.talos.mjs');
    const base = pathToFileURL(join(dir, STRYKER_BASE)).href;
    await rm(report, { force: true });
    await writeFile(config, strykerWrapper(base, mine, report));
    const tool = await nodeTool(ctx, '@stryker-mutator/core', 'stryker');
    const result = await runTool(ctx, tool, ['run', config, '--logLevel', 'warn'], {
      timeoutMs: 3 * 60 * 60 * 1000,
    });
    if (!(await exists(report))) {
      throw new EngineError(`stryker exited ${result.code} without a report:\n${tail(result)}`);
    }
    return { path: report, base: dir, format: 'stryker' };
  },
};

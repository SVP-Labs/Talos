import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Command, parse } from './io.js';
import { loadConfig } from '../config/load.js';
import { renderConfigs } from '../configs/files.js';
import type { ApplyContext } from '../core/check.js';
import type { Pack } from '../core/pack.js';
import { PACKS } from '../core/registry.js';
import { exec as realExec, type Exec } from '../exec/exec.js';
import { capped } from '../govern/output.js';
import { repoFacts } from '../repo/facts.js';
import { git, trackedFiles } from '../repo/git.js';
import { ownVersion } from '../version/self.js';

export type Written = {
  /** Generated files whose content changed. */
  readonly written: readonly string[];
  /** Extension files that were missing, created from their initial content. */
  readonly created: readonly string[];
};

async function current(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

async function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * Writes every generated file that applies to the repository at `root` and creates each missing
 * extension file; it never touches an extension file that exists.
 */
export async function writeConfigs(
  root: string,
  run: Exec,
  packs: readonly Pack[],
  version: string,
): Promise<Written> {
  const config = await loadConfig(root);
  const facts = repoFacts(await trackedFiles(git(run, root)), config.exclude);
  const ctx: ApplyContext = { facts, config, side: 'alone', tiers: ['commit', 'head'] };
  const written: string[] = [];
  const created: string[] = [];
  for (const file of renderConfigs(packs, ctx, version)) {
    const path = join(root, file.path);
    if ((await current(path)) !== file.content) {
      await put(path, file.content);
      written.push(file.path);
    }
    const extension = file.extension;
    if (extension !== undefined && !(await present(join(root, extension.path)))) {
      await put(join(root, extension.path), extension.content);
      created.push(extension.path);
    }
  }
  return { written, created };
}

function text(result: Written): string {
  const lines = [
    ...result.written.map((path) => `wrote   ${path}`),
    ...result.created.map((path) => `created ${path}`),
  ];
  return lines.length === 0 ? 'every generated config is up to date\n' : `${lines.join('\n')}\n`;
}

/**
 * `talos configs`: writes the generated tool configs as this Talos renders them, and creates the
 * extension files a project is missing. `--json` lists the paths, capped.
 */
export const configs: Command = async (argv, io) => {
  const { values } = parse(argv, { json: { type: 'boolean', default: false } });
  const result = await writeConfigs(io.cwd, realExec, PACKS, ownVersion());
  io.out(
    values.json
      ? `${JSON.stringify({ written: capped(result.written), created: capped(result.created) })}\n`
      : text(result),
  );
  return 0;
};

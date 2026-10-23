import { readdir, readFile } from 'node:fs/promises';
import { parseDefaults } from './dependabot.js';
import type { AdoptAssets } from './plan.js';
import { RUNNER_PATCH } from './supply.js';
import { assetsDir } from '../version/self.js';

async function optional(url: URL): Promise<string | undefined> {
  try {
    return await readFile(url, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The issue forms, PR template, Dependabot settings, `CLAUDE.md` block and patches this Talos
 * ships.
 */
export async function loadAdoptAssets(dir: URL = assetsDir()): Promise<AdoptAssets> {
  const formsDir = new URL('issue-forms/', dir);
  const names = (await readdir(formsDir))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  const forms = await Promise.all(names.map((name) => readFile(new URL(name, formsDir), 'utf8')));
  const issueForms = Object.fromEntries(names.map((name, index) => [name, forms[index] ?? '']));
  const [prTemplate, defaults, claudeKit, runnerPatch] = await Promise.all([
    optional(new URL('pull_request_template.md', dir)),
    readFile(new URL('dependabot/update.yml', dir), 'utf8'),
    readFile(new URL('claude/kit-block.md', dir), 'utf8'),
    optional(new URL(`patches/${RUNNER_PATCH}`, dir)),
  ]);
  return { issueForms, prTemplate, dependabot: parseDefaults(defaults), claudeKit, runnerPatch };
}

import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lint } from 'cspell';
import {
  CSPELL_CONFIG,
  gateSettings,
  renderCspellBase,
  spellingFiles,
  spellingFinding,
  WORDS_FILE,
} from './cspell.js';
import { readOwnTexts, readText } from './files.js';
import { APPLIES, type Check, type CheckContext, EngineError, skip } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { Generated } from '../../core/pack.js';
import { glossaryWords, parseGlossary } from '../../docs/glossary.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The project's files minus the configs Talos rendered, whose words are Talos's. */
async function ownFiles(ctx: CheckContext): Promise<string[]> {
  return (await readOwnTexts(ctx, spellingFiles(ctx.facts))).map((doc) => doc.file);
}

/** Writes the run's settings into the scratch directory: the glossary's terms are a dictionary. */
async function writeSettings(ctx: CheckContext): Promise<string> {
  const glossaryText = await readText(ctx, ctx.config.docs.glossary);
  const glossary = join(ctx.scratch, 'glossary.txt');
  const terms = glossaryText === undefined ? [] : glossaryWords(parseGlossary(glossaryText));
  await writeFile(glossary, `${terms.join('\n')}\n`);
  const words = join(ctx.root, WORDS_FILE);
  const settings = gateSettings({ glossary, ...((await exists(words)) ? { words } : {}) });
  const path = join(ctx.scratch, 'cspell.json');
  await writeFile(path, JSON.stringify(settings, null, 2));
  return path;
}

async function spell(ctx: CheckContext): Promise<Finding[]> {
  const files = await ownFiles(ctx);
  if (files.length === 0) return [];
  const config = await writeSettings(ctx);
  const list = join(ctx.scratch, 'files.txt');
  // cspell reads a file list's entries relative to the list itself, so they are absolute.
  await writeFile(list, `${files.map((file) => join(ctx.root, file)).join('\n')}\n`);
  const issues: unknown[] = [];
  const errors: string[] = [];
  await lint(
    [],
    {
      config,
      root: ctx.root,
      fileList: [list],
      progress: false,
      summary: false,
      mustFindFiles: false,
      gitignore: false,
      dot: true,
    },
    {
      issue: (issue) => issues.push(issue),
      error: (message) => errors.push(message),
      info: () => undefined,
      debug: () => undefined,
      progress: () => undefined,
      result: () => undefined,
    },
  );
  if (errors.length > 0) throw new EngineError(`cspell failed: ${errors[0] ?? ''}`);
  return issues.map((issue) => spellingFinding(ctx.root, issue));
}

/** cspell over docs, code, scripts and CI: one finding per unknown word where it occurs. */
export const spellingCheck: Check = {
  id: 'docs/spelling',
  tier: 'head',
  scope: 'repo',
  title: 'cspell',
  applies: (ctx) =>
    spellingFiles(ctx.facts).length > 0 ? APPLIES : skip('the repository has nothing to spell'),
  run: spell,
};

export const cspellBase: Generated = {
  path: CSPELL_CONFIG,
  scope: 'repo',
  applies: (ctx) => spellingFiles(ctx.facts).length > 0,
  render: (ctx) =>
    renderCspellBase(
      ctx.version,
      ctx.config.exclude,
      ctx.config.components.map((component) => component.lang),
    ),
  extension: {
    path: WORDS_FILE,
    initial: () => "# Words the dictionaries don't know, one per line, grouped and sorted.\n",
  },
};

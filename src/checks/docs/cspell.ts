import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { excludeGlobs } from './markdownlint.js';
import { generatedHeader } from '../../configs/header.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import { KIT_BEGIN, KIT_END } from '../../docs/claude.js';
import type { RepoFacts } from '../../repo/facts.js';

export const CSPELL_CONFIG = 'cspell.config.yaml';
/** The project's own words: the extension, which only adds what the dictionaries lack. */
export const WORDS_FILE = '.cspell/words.txt';

/** Docs, code, scripts and CI. */
const SPELLING_GLOBS = [
  '**/*.{md,markdown}',
  '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  '**/*.{py,pyi,php,lua,rs}',
  '**/*.{sh,bash,ps1,psm1,psd1}',
  '**/*.{yml,yaml,toml,jsonc}',
  '**/Dockerfile',
  '**/*.Dockerfile',
  '.githooks/*',
];
const NOT_SPELLED = ['**/pnpm-lock.yaml', '**/*.lock'];

/** Words of the text Talos writes into every repository and the project keeps. */
export const KIT_WORDS = ['talos'];

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** What isn't prose: Talos's block in `CLAUDE.md`, advisory IDs, digests, commit SHAs. */
export const IGNORED_PATTERNS = [
  `/${escapeRegExp(KIT_BEGIN)}[\\s\\S]*?${escapeRegExp(KIT_END)}/g`,
  '/GHSA(-[0-9a-z]{4}){3}/g',
  '/sha256:[0-9a-f]{64}/g',
  String.raw`/\b[0-9a-f]{40}\b/g`,
  String.raw`/\[[A-Za-z0-9#^-]{8,}\]/g`,
];

const LANGUAGE = 'en,en-GB';

function yamlList(items: readonly string[]): string[] {
  return items.map((item) => `  - '${item.replaceAll("'", "''")}'`);
}

/** The base for editors and `cspell`, written as Prettier writes it. */
export function renderCspellBase(version: string, exclude: readonly string[]): string {
  return [
    generatedHeader('#', version).trimEnd(),
    '# Spelling in docs, code, scripts and CI, in British or American English. Words the',
    `# dictionaries don't know go in ${WORDS_FILE}, one per line.`,
    "version: '0.2'",
    `language: ${LANGUAGE}`,
    'dictionaryDefinitions:',
    '  - name: project',
    `    path: ./${WORDS_FILE}`,
    '    addWords: true',
    'dictionaries: [project]',
    `words: [${KIT_WORDS.join(', ')}]`,
    'ignoreRegExpList:',
    ...yamlList(IGNORED_PATTERNS),
    'ignorePaths:',
    ...yamlList(['**/node_modules/**', '.cspell/**', ...NOT_SPELLED, ...excludeGlobs(exclude)]),
    '',
  ].join('\n');
}

export type GateDictionaries = {
  /** Absolute path of the project's word list, when it has one. */
  readonly words?: string;
  /** Absolute path of the dictionary written from the glossary's terms. */
  readonly glossary: string;
};

/**
 * The settings the gate runs with: the base's, the project's word list and the glossary's
 * terms, and no configuration file found anywhere else in the checkout.
 */
export function gateSettings(dictionaries: GateDictionaries): Record<string, unknown> {
  const definitions = [
    ...(dictionaries.words === undefined
      ? []
      : [{ name: 'project', path: dictionaries.words, addWords: true }]),
    { name: 'glossary', path: dictionaries.glossary },
  ];
  return {
    version: '0.2',
    language: LANGUAGE,
    dictionaryDefinitions: definitions,
    dictionaries: definitions.map((definition) => definition.name),
    words: KIT_WORDS,
    ignoreRegExpList: IGNORED_PATTERNS,
    noConfigSearch: true,
  };
}

/** The tracked files the spelling check reads. */
export function spellingFiles(facts: RepoFacts): string[] {
  const skipped = new Set(facts.matching(...NOT_SPELLED));
  return facts.matching(...SPELLING_GLOBS).filter((file) => !skipped.has(file));
}

const issueSchema = z.object({
  text: z.string(),
  row: z.number().int().positive(),
  col: z.number().int().positive(),
  uri: z.string(),
  isFlagged: z.boolean().optional(),
});

/** A finding from one cspell issue; `root` is the checkout the paths are relative to. */
export function spellingFinding(root: string, issue: unknown): Finding {
  const parsed = issueSchema.safeParse(issue);
  if (!parsed.success) throw new EngineError('cspell reported an issue Talos cannot read');
  const { text, row, col, uri } = parsed.data;
  const file = relative(root, uri.startsWith('file:') ? fileURLToPath(uri) : uri)
    .split(sep)
    .join('/');
  const what = parsed.data.isFlagged === true ? 'Forbidden word' : 'Unknown word';
  return {
    rule: 'cspell/unknown-word',
    message: `${what} "${text}": correct it, or add it to ${WORDS_FILE}.`,
    location: { file, line: row, column: col },
  };
}

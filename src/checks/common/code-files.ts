import picomatch from 'picomatch';
import type { RepoFacts } from '../../repo/facts.js';

/**
 * The programming languages jscpd compares, as jscpd names them and by the extensions it reads
 * for each: the languages Talos governs, scripts, and any other language a repository carries.
 * Markup, styles, docs and data are left out: repeating them is layout, not logic.
 */
const LANGUAGES: readonly (readonly [format: string, extensions: readonly string[]])[] = [
  ['typescript', ['ts', 'mts', 'cts']],
  ['tsx', ['tsx']],
  ['javascript', ['js', 'mjs', 'cjs']],
  ['jsx', ['jsx']],
  ['vue', ['vue']],
  ['svelte', ['svelte']],
  ['astro', ['astro']],
  ['python', ['py', 'pyi']],
  ['php', ['php']],
  ['lua', ['lua']],
  ['rust', ['rs']],
  ['bash', ['sh', 'bash']],
  ['powershell', ['ps1', 'psm1']],
  ['go', ['go']],
  ['java', ['java']],
  ['kotlin', ['kt', 'kts']],
  ['scala', ['scala']],
  ['csharp', ['cs']],
  ['c', ['c']],
  ['c-header', ['h']],
  ['cpp', ['cc', 'cpp', 'cxx']],
  ['cpp-header', ['hpp', 'hh']],
  ['ruby', ['rb']],
  ['swift', ['swift']],
  ['dart', ['dart']],
];

/** jscpd's names for the languages it compares. */
export const JSCPD_FORMATS: readonly string[] = LANGUAGES.map(([format]) => format);

/** Every file of a language jscpd compares. */
const CODE_GLOBS: readonly string[] = [
  `**/*.{${LANGUAGES.flatMap(([, extensions]) => extensions).join(',')}}`,
];

/** Tests and what only tests use, by each language's conventions; repeating them is allowed. */
const TEST_GLOBS: readonly string[] = [
  '**/{test,tests,spec,specs,e2e,testing,__tests__,__mocks__,fixtures}/**',
  '**/*.{test,spec}.*',
  '**/test_*.py',
  '**/*_test.{py,go,lua}',
  '**/conftest.py',
  '**/*Test.php',
  '**/*_spec.lua',
];

/** Blade views: markup in PHP files, whose repetition is layout. */
const TEMPLATE_GLOBS: readonly string[] = ['**/*.blade.php'];

/** What the duplication check never compares, beside `talos.yml`'s `exclude`. */
export const NOT_COMPARED: readonly string[] = [...TEST_GLOBS, ...TEMPLATE_GLOBS];

/** The tracked code the duplication check compares: every language's, minus tests. */
export function comparedFiles(facts: RepoFacts): string[] {
  const skipped = picomatch([...NOT_COMPARED], { dot: true });
  return facts.matching(...CODE_GLOBS).filter((file) => !skipped(file));
}

import { join } from 'node:path';
import {
  type Mutant,
  mutantFinding,
  parseCargoMutants,
  parseInfection,
  parseMutmut,
  parseStryker,
} from './mutants.js';
import { inComponent, inRepository } from './paths.js';
import type { MutationFormat, MutationRunner, Report } from './protocol.js';
import { readReport } from './reports.js';
import {
  type ApplyContext,
  type Applicability,
  APPLIES,
  type Check,
  type CheckContext,
  type Lang,
  skip,
} from '../core/check.js';
import type { Finding } from '../core/finding.js';
import { excludeMatcher } from '../repo/facts.js';

/** Each language's source files; a TypeScript declaration file holds nothing to mutate. */
const SOURCE: Readonly<Record<Lang, RegExp>> = {
  ts: /(?<!\.d)\.(?:[cm]?[jt]s|[jt]sx)$/,
  py: /\.py$/,
  php: /\.php$/,
  lua: /\.lua$/,
  rust: /\.rs$/,
};

const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e']);

const TEST_NAMES = [
  /\.(?:test|spec)\.[^.]+$/,
  /^test_.*\.py$/,
  /_test\.py$/,
  /^conftest\.py$/,
  /Test\.php$/,
  /_spec\.lua$/,
];

/** Test code, which mutation never targets: test directories and each language's test names. */
function isTest(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const directories = file.split('/').slice(0, -1);
  return (
    directories.some((part) => TEST_DIRECTORIES.has(part)) || TEST_NAMES.some((re) => re.test(name))
  );
}

/** Whether a repository-relative path is shipped source of the language under mutation paths. */
function mutable(lang: Lang, ctx: ApplyContext): (file: string) => boolean {
  const declared = excludeMatcher(ctx.config.mutation);
  return (file) =>
    declared(file) && inComponent(ctx.component, file) && SOURCE[lang].test(file) && !isTest(file);
}

function applicability(lang: Lang, ctx: ApplyContext): Applicability {
  if (ctx.config.mutation.length === 0) return skip('talos.yml declares no mutation paths');
  const wanted = mutable(lang, ctx);
  if (ctx.side === 'alone') {
    return ctx.facts.files.some(wanted)
      ? APPLIES
      : skip('no source file of the component is under the mutation paths');
  }
  if (ctx.changes === undefined) return skip('nothing is compared');
  const touched = [...ctx.changes.files.values()].some(
    (change) => wanted(change.path) || (change.oldPath !== undefined && wanted(change.oldPath)),
  );
  return touched ? APPLIES : skip('the change touches no file under the mutation paths');
}

/**
 * The files to mutate at this checkout: every one under the mutation paths when nothing is
 * compared, otherwise those the change touches, by their name on this side.
 */
export function mutationTargets(lang: Lang, ctx: ApplyContext): string[] {
  const wanted = mutable(lang, ctx);
  if (ctx.side === 'alone') return ctx.facts.files.filter(wanted);
  if (ctx.changes === undefined) return [];
  const present = new Set(ctx.facts.files);
  const names = [...ctx.changes.files.values()].flatMap((change): string[] => {
    if (ctx.side === 'head') return change.status === 'deleted' ? [] : [change.path];
    return change.status === 'added' ? [] : [change.oldPath ?? change.path];
  });
  return [...new Set(names)]
    .filter((file) => present.has(file) && wanted(file))
    .sort((a, b) => a.localeCompare(b));
}

async function sources(ctx: CheckContext, files: readonly string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const file of files) {
    texts.set(file, await readReport(join(ctx.root, file), 'mutated source'));
  }
  return texts;
}

async function readMutants(
  ctx: CheckContext,
  report: Report & { readonly format: MutationFormat },
  targets: readonly string[],
): Promise<Mutant[]> {
  const text = await readReport(report.path, `${report.format} mutation report`);
  switch (report.format) {
    case 'stryker':
      return parseStryker(text);
    case 'infection':
      return parseInfection(text);
    case 'mutmut':
      return parseMutmut(text);
    case 'cargo-mutants': {
      const texts = await sources(ctx, targets);
      return parseCargoMutants(text, (file) => {
        const path = inRepository(ctx.root, report.base, file);
        return path === undefined ? undefined : texts.get(path);
      });
    }
  }
}

/** `<lang>/mutation` (head tier): the declared mutation paths a change touches. */
export function mutationChecks(lang: Lang, runner: MutationRunner): Check[] {
  return [
    {
      id: `${lang}/mutation`,
      tier: 'head',
      scope: 'component',
      langs: [lang],
      title: 'Mutation testing',
      applies: (ctx) => applicability(lang, ctx),
      run: async (ctx): Promise<Finding[]> => {
        const targets = mutationTargets(lang, ctx);
        if (targets.length === 0) return [];
        const report = await runner.run(ctx, targets);
        const wanted = new Set(targets);
        return (await readMutants(ctx, report, targets)).flatMap((mutant) => {
          const file = inRepository(ctx.root, report.base, mutant.file);
          const survived = mutant.status !== 'other';
          return survived && file !== undefined && wanted.has(file)
            ? [mutantFinding(mutant, file)]
            : [];
        });
      },
    },
  ];
}

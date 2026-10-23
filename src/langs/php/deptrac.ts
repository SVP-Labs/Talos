import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { namespacesOf, readLock, readManifest } from './composer.js';
import {
  classmapClasses,
  DEPTRAC_PROJECT,
  deptracConfig,
  devPrefixes,
  escapePcre,
  testPattern,
} from './deptrac-config.js';
import { absolute, componentDir, fileExists, fromTool, inRepo, phpFiles, tracks } from './paths.js';
import { type Bound, failed, jsonFrom, runVendorTool, sentence } from './run.js';
import { scopeFor } from './scope.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const report = z.object({
  Report: z.object({ Errors: z.number().int().default(0) }),
  files: z
    .union([
      z.record(
        z.string(),
        z.object({
          messages: z.array(
            z.object({ message: z.string(), line: z.number().int(), type: z.string() }),
          ),
        }),
      ),
      z.tuple([]),
    ])
    .default([]),
});

export type Violation = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

export type DeptracReport = {
  readonly violations: readonly Violation[];
  /** Errors in the config (an unmatched skipped violation, a layer cycle), counted only. */
  readonly errors: number;
};

/**
 * deptrac's JSON report. Every message is a violation: a skipped one too, since the gate is run
 * with `--report-skipped` (a list of skipped violations is a stored baseline), and uncovered
 * dependencies are never asked for.
 */
export function parseDeptracJson(json: unknown): DeptracReport {
  const parsed = report.safeParse(json);
  if (!parsed.success) throw new EngineError('deptrac wrote JSON Talos cannot read');
  const files = Array.isArray(parsed.data.files) ? {} : parsed.data.files;
  const violations = Object.entries(files).flatMap(([file, entry]) =>
    entry.messages.map((m) => ({ file, line: m.line, message: m.message })),
  );
  return { violations, errors: parsed.data.Report.Errors };
}

const UNIVERSAL = /^(.+) must not depend on (.+) \(Shipped on (Tests|DevDependencies)\)$/;

/** A universal rule's violation in words; a project's own keeps deptrac's message. */
export function universalFinding(v: Violation, toRepo: (file: string) => string): Finding {
  const match = UNIVERSAL.exec(v.message);
  const location = { file: toRepo(v.file), line: v.line };
  if (match === null) {
    return { rule: 'deptrac/layers', message: sentence(v.message), location };
  }
  const [, from = '', to = '', layer] = match;
  const test = layer === 'Tests';
  return {
    rule: test ? 'deptrac/test-code' : 'deptrac/dev-dependency',
    message: test
      ? `Shipped code must not use test code: ${from} uses ${to}.`
      : `Shipped code must not use a package only require-dev installs: ${from} uses ${to}.`,
    location,
  };
}

async function analyse(ctx: Bound, config: string, name: string): Promise<DeptracReport> {
  const output = join(ctx.scratch, `${name}.json`);
  const args = ['analyse', `--config-file=${config}`, '--formatter=json', `--output=${output}`];
  const flags = ['--report-skipped', '--no-progress', '--no-cache'];
  const result = await runVendorTool(ctx, 'deptrac', [...args, ...flags]);
  if (!(await fileExists(output))) throw failed('deptrac analyse', result);
  return parseDeptracJson(jsonFrom(await readFile(output, 'utf8'), 'deptrac'));
}

/** The namespaces the project's own autoload declares, its tests' included. */
async function ownNamespaces(ctx: Bound): Promise<string[]> {
  const manifest = await readManifest(ctx);
  return [...namespacesOf(manifest.autoload), ...namespacesOf(manifest['autoload-dev'])];
}

/** The universal rules over every checked file, with the dev-only packages composer.lock names. */
async function universal(ctx: Bound): Promise<readonly Violation[]> {
  const scope = await scopeFor(ctx, phpFiles(ctx));
  const classmap = await readFile(absolute(ctx, 'vendor/composer/autoload_classmap.php'), 'utf8')
    .then(classmapClasses)
    .catch(() => new Map<string, string[]>());
  const exclude = [...scope.excluded, ...scope.excludedDirs].map(
    (path) => `#^${escapePcre(absolute(ctx, path).replaceAll('\\', '/'))}(/|$)#`,
  );
  const config = deptracConfig({
    paths: scope.paths.map((path) => absolute(ctx, path)),
    excludeFiles: exclude,
    tests: testPattern(componentDir(ctx).replaceAll('\\', '/')),
    devPrefixes: devPrefixes(await readLock(ctx), classmap, await ownNamespaces(ctx)),
  });
  const file = join(ctx.scratch, 'deptrac.universal.yaml');
  await writeFile(file, stringify(config));
  const found = await analyse(ctx, file, 'universal');
  if (found.errors > 0) {
    throw new EngineError(`deptrac found ${found.errors} error(s) in Talos's config`);
  }
  return found.violations;
}

/** The project's own layers, run as written; errors in its config are the project's to fix. */
async function project(ctx: Bound, toRepo: (file: string) => string): Promise<Finding[]> {
  const found = await analyse(ctx, absolute(ctx, DEPTRAC_PROJECT), 'project');
  const where = inRepo(ctx.component.root, DEPTRAC_PROJECT);
  const errors: Finding[] =
    found.errors === 0
      ? []
      : [
          {
            rule: 'deptrac/config',
            message: `deptrac found ${found.errors} error(s) in ${where}, such as a skipped violation that no longer occurs; run deptrac on it to see them.`,
            key: `${where} errors`,
          },
        ];
  const violations = found.violations.map((v): Finding => ({
    rule: 'deptrac/layers',
    message: sentence(v.message),
    location: { file: toRepo(v.file), line: v.line },
  }));
  return [...violations, ...errors];
}

/**
 * php/arch: the universal rules always, and the project's own layers from deptrac.project.yaml
 * when it has one, run as written, since deptrac's rules are the project's to state.
 */
export async function arch(ctx: Bound): Promise<Finding[]> {
  const toRepo = (file: string): string => fromTool(ctx, file);
  const found = (await universal(ctx)).map((v) => universalFinding(v, toRepo));
  return tracks(ctx, DEPTRAC_PROJECT) ? [...found, ...(await project(ctx, toRepo))] : found;
}

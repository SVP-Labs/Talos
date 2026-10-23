import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type NeonMap, toNeon } from './neon.js';
import { absolute, fileExists, fromTool, phpFiles, tracks } from './paths.js';
import { type Extension, gateIncludes, PHPSTAN_PARAMETERS } from './phpstan-config.js';
import {
  type Bound,
  failed,
  jsonFrom,
  runPhp,
  runVendorTool,
  sentence,
  type ToolContext,
} from './run.js';
import { type Scope, scopeFor } from './scope.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';

const message = z.object({
  message: z.string(),
  line: z.number().int().nullable().optional(),
  identifier: z.string().optional(),
});

/** PHP encodes an empty map as `[]`, which is what PHPStan prints when no file has errors. */
const report = z.object({
  files: z
    .union([z.record(z.string(), z.object({ messages: z.array(message) })), z.tuple([])])
    .default([]),
  errors: z.array(z.string()).default([]),
});

type PhpstanMessage = {
  /** As PHPStan printed it: absolute. */
  readonly file: string;
  readonly line: number;
  readonly identifier: string;
  readonly message: string;
};

export type PhpstanReport = {
  readonly messages: readonly PhpstanMessage[];
  /** Errors tied to no file: unmatched ignore patterns, internal errors. */
  readonly general: readonly string[];
};

export function parsePhpstanJson(json: unknown): PhpstanReport {
  const parsed = report.safeParse(json);
  if (!parsed.success) throw new EngineError('PHPStan printed JSON Talos cannot read');
  const files = Array.isArray(parsed.data.files) ? {} : parsed.data.files;
  const messages = Object.entries(files).flatMap(([file, entry]) =>
    entry.messages.map((m) => ({
      file,
      line: m.line ?? 1,
      identifier: m.identifier ?? 'error',
      message: m.message,
    })),
  );
  return { messages, general: parsed.data.errors };
}

export type Bucket = 'types' | 'lint' | 'deadcode';

const DEAD = [/^shipmonk\.dead/, /\.unused$/, /^property\.only(?:Read|Written)$/, /^deadCode\./];

/** Which check reports an identifier: dead code, cognitive complexity (lint), or types. */
export function bucketOf(identifier: string): Bucket {
  if (DEAD.some((pattern) => pattern.test(identifier))) return 'deadcode';
  return identifier.startsWith('complexity.') ? 'lint' : 'types';
}

const UNMATCHED = /^Ignored error pattern .* was not matched in reported errors\.$/;

/**
 * Findings by check. An internal error makes PHPStan skip its whole-project rules (dead code,
 * type coverage), so a report with one can't be trusted: an engine error.
 */
export function phpstanFindings(
  parsed: PhpstanReport,
  toRepo: (file: string) => string,
): Record<Bucket, Finding[]> {
  const internal = parsed.general.filter((text) => !UNMATCHED.test(text));
  if (internal.length > 0) {
    throw new EngineError(
      `PHPStan could not analyse everything: ${internal.join(' ').slice(0, 500)}`,
    );
  }
  const buckets: Record<Bucket, Finding[]> = { types: [], lint: [], deadcode: [] };
  for (const m of parsed.messages) {
    buckets[bucketOf(m.identifier)].push({
      rule: `phpstan/${m.identifier}`,
      message: sentence(m.message),
      location: { file: toRepo(m.file), line: m.line },
    });
  }
  for (const text of parsed.general) {
    buckets.types.push({ rule: 'phpstan/ignore.unmatched', message: sentence(text), key: text });
  }
  return buckets;
}

/** The packages phpstan/extension-installer includes on its own, which PHPStan refuses twice. */
export async function installerPackages(ctx: ToolContext): Promise<ReadonlySet<string>> {
  const file = absolute(ctx, 'vendor/phpstan/extension-installer/src/GeneratedConfig.php');
  if (!(await fileExists(file))) return new Set();
  const code =
    'require $argv[1]; echo json_encode(array_keys(' +
    '\\PHPStan\\ExtensionInstaller\\GeneratedConfig::EXTENSIONS));';
  const result = await runPhp(ctx, ['-r', code, file]);
  const names = z
    .object({ names: z.array(z.string()) })
    .safeParse(jsonFrom(`{"names":${result.stdout.trim() || 'null'}}`, 'the extension installer'));
  if (result.code !== 0 || !names.success) throw failed('reading the extension installer', result);
  return new Set(names.data.names);
}

/** A Laravel application: one with `artisan` at its root, which Larastan's rules need. */
export function laravelApp(ctx: Pick<Bound, 'facts' | 'component'>): boolean {
  return tracks(ctx, 'artisan');
}

export type RunConfig = {
  readonly scope: Scope;
  readonly parameters: NeonMap;
  readonly extra?: readonly Extension[];
};

/**
 * Writes the gate's config into the scratch directory: the base's includes and parameters,
 * then what the gate decides itself. The project's ignoreErrors and excludePaths are replaced,
 * since a list of ignored errors is a stored baseline; inline ignores stay, as suppressions.
 */
export async function writeConfig(ctx: Bound, name: string, run: RunConfig): Promise<string> {
  const includes = await gateIncludes(ctx, {
    laravel: laravelApp(ctx),
    installed: await installerPackages(ctx),
    project: true,
    ...(run.extra === undefined ? {} : { extra: run.extra }),
  });
  const abs = (path: string): string => absolute(ctx, path);
  const parameters: NeonMap = {
    ...PHPSTAN_PARAMETERS,
    'paths!': run.scope.paths.map(abs),
    'excludePaths!': { analyse: [...run.scope.excluded, ...run.scope.excludedDirs].map(abs) },
    'ignoreErrors!': [],
    tmpDir: join(ctx.scratch, `${name}-tmp`),
    ...run.parameters,
  };
  const path = join(ctx.scratch, `${name}.neon`);
  await mkdir(ctx.scratch, { recursive: true });
  await writeFile(path, toNeon({ includes, parameters }));
  return path;
}

/** Runs `phpstan analyse` with a config and reads its JSON report. */
export async function analyse(ctx: Bound, config: string): Promise<PhpstanReport> {
  const args = ['analyse', '-c', config, '--error-format=json', '--no-progress', '--no-ansi'];
  const result = await runVendorTool(ctx, 'phpstan', [...args, '--memory-limit=-1']);
  if (result.code > 1 || !result.stdout.trimStart().startsWith('{')) {
    throw failed('phpstan analyse', result);
  }
  return parsePhpstanJson(jsonFrom(result.stdout, 'phpstan analyse'));
}

/** One analysis of every checked PHP file, shared by php/types, php/lint and php/deadcode. */
export async function phpstanRun(ctx: Bound): Promise<Record<Bucket, Finding[]>> {
  return ctx.memo(`php/phpstan:${ctx.component.root}`, async () => {
    const scope = await scopeFor(ctx, phpFiles(ctx));
    const config = await writeConfig(ctx, 'phpstan', { scope, parameters: {} });
    const parsed = await analyse(ctx, config);
    return phpstanFindings(parsed, (file) => fromTool(ctx, file));
  });
}

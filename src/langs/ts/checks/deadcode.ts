import { z } from 'zod';
import { sentence } from './lint.js';
import { type Check, type CheckContext, EngineError, skip, APPLIES } from '../../../core/check.js';
import type { Finding } from '../../../core/finding.js';
import { KNIP_BASE } from '../configs/knip.js';
import { componentFiles, inRepo, isCode, rootOf } from '../files.js';
import { nodeTool, parseJson, runTool, tail } from '../node.js';

const item = z.looseObject({
  name: z.string().optional(),
  namespace: z.string().optional(),
  line: z.number().optional(),
  col: z.number().optional(),
});

type Item = z.infer<typeof item>;

const report = z.object({
  issues: z.array(z.looseObject({ file: z.string() })),
});

/** Kinds whose subject is a package.json entry, identified by name rather than by code. */
const BY_NAME = new Set([
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'binaries',
  'catalog',
  'catalogReferences',
]);

const GROUPED = new Set(['duplicates', 'cycles']);

function describe(kind: string, file: string, entry: Item): string {
  const name = entry.name ?? '';
  const messages: Readonly<Record<string, string>> = {
    files: `${file} is not reached from any entry point.`,
    dependencies: `${name} is in dependencies, but nothing uses it.`,
    devDependencies: `${name} is in devDependencies, but nothing uses it.`,
    optionalPeerDependencies: `${name} is an optional peer dependency nothing uses.`,
    unlisted: `${name} is imported but not listed in package.json.`,
    binaries: `${name} is run as a program, but no dependency provides it.`,
    unresolved: `${name} cannot be resolved.`,
    exports: `${name} is exported but never imported.`,
    nsExports: `${name} is exported through a namespace but never used.`,
    types: `The type ${name} is exported but never imported.`,
    nsTypes: `The type ${name} is exported through a namespace but never used.`,
    enumMembers: `${entry.namespace ?? ''}.${name} is never used.`,
    namespaceMembers: `${entry.namespace ?? ''}.${name} is never used.`,
    classMembers: `${entry.namespace ?? ''}.${name} is never used.`,
    catalog: `${name} is in the catalog, but nothing uses it.`,
    catalogReferences: `${name} refers to a catalog entry that does not exist.`,
  };
  return messages[kind] ?? `${name} is unused (${kind}).`;
}

function grouped(kind: string, file: string, entries: readonly Item[]): Finding {
  const names = entries.map((entry) => entry.name ?? '').filter(Boolean);
  const message =
    kind === 'cycles'
      ? `Import cycle: ${[file, ...names].join(' -> ')}.`
      : `${names.join(', ')} export the same thing; keep one.`;
  const first = entries[0];
  return {
    rule: `knip/${kind}`,
    message: sentence(message),
    location: {
      file,
      line: first?.line ?? 1,
      ...(first?.col === undefined ? {} : { column: first.col }),
    },
  };
}

function single(kind: string, file: string, entry: Item): Finding {
  const finding: Finding = {
    rule: `knip/${kind}`,
    message: sentence(describe(kind, file, entry)),
    location: {
      file,
      line: entry.line ?? 1,
      ...(entry.col === undefined ? {} : { column: entry.col }),
    },
  };
  return BY_NAME.has(kind) ? { ...finding, key: `${kind} ${entry.name ?? ''}` } : finding;
}

function rowFindings(kind: string, file: string, value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  if (GROUPED.has(kind)) {
    return value.flatMap((group): Finding[] => {
      const entries = z.array(item).safeParse(group);
      return entries.success && entries.data.length > 0 ? [grouped(kind, file, entries.data)] : [];
    });
  }
  return value.flatMap((entry): Finding[] => {
    const parsed = item.safeParse(entry);
    return parsed.success ? [single(kind, file, parsed.data)] : [];
  });
}

/** Reads knip's JSON reporter; `toRepo` makes its paths repository-relative. */
export function parseKnip(json: unknown, toRepo: (file: string) => string): Finding[] {
  const parsed = report.safeParse(json);
  if (!parsed.success) throw new EngineError('knip wrote JSON Talos cannot read');
  return parsed.data.issues.flatMap((row) => {
    const file = toRepo(row.file);
    return Object.entries(row)
      .filter(([kind]) => kind !== 'file' && kind !== 'owners')
      .flatMap(([kind, value]) => rowFindings(kind, file, value));
  });
}

async function run(ctx: CheckContext): Promise<Finding[]> {
  const root = rootOf(ctx.component);
  const tool = await nodeTool(ctx, 'knip', 'knip');
  const args = ['--config', KNIP_BASE, '--reporter', 'json', '--no-progress', '--no-config-hints'];
  const result = await runTool(ctx, tool, args);
  if (result.code > 1) throw new EngineError(`knip exited ${result.code}:\n${tail(result)}`);
  return parseKnip(parseJson('knip', result.stdout), (file) => inRepo(root, file));
}

export const deadcodeCheck: Check = {
  id: 'ts/deadcode',
  tier: 'commit',
  scope: 'component',
  langs: ['ts'],
  title: 'Knip: unused files, exports and dependencies',
  applies: (ctx) =>
    componentFiles(ctx).some((file) => isCode(file))
      ? APPLIES
      : skip('no TypeScript or JavaScript'),
  run,
};

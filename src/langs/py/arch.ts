import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pyprojectTool } from './configs.js';
import { readEnvironment } from './environment.js';
import {
  type BrokenContract,
  type BrokenImport,
  contractTypes,
  packageRoots,
  parseImportLinter,
  type Roots,
  UNIVERSAL_TYPES,
  universalConfig,
} from './importlinter.js';
import { devOnlyDistributions, devOnlyModules } from './lock.js';
import { componentDir, fileExists, inRepo, pythonFiles } from './paths.js';
import { type Bound, runTool, tail } from './run.js';
import { EngineError } from '../../core/check.js';
import type { Finding, Location } from '../../core/finding.js';

/** The file a module lives in, repository-relative, among the component's Python files. */
function moduleFile(module: string, files: ReadonlySet<string>, root: string): string | undefined {
  const path = module.replaceAll('.', '/');
  const candidates = ['', 'src/'].flatMap((at) => [`${at}${path}.py`, `${at}${path}/__init__.py`]);
  const found = candidates.find((candidate) => files.has(candidate));
  return found === undefined ? undefined : inRepo(root, found);
}

type Judged = { readonly contract: BrokenContract; readonly type: string };

function importFinding(
  ctx: Bound,
  judged: Judged,
  files: ReadonlySet<string>,
  b: BrokenImport,
): Finding {
  const { contract, type } = judged;
  const rule = `import-linter/${type}`;
  if (contract.cycleIn !== undefined) {
    return {
      rule,
      message: `${b.importer} imports ${b.imported}, which closes an import cycle in ${contract.cycleIn}.`,
      key: `${contract.name}: ${b.importer} -> ${b.imported}`,
    };
  }
  const via = b.target === b.imported ? '' : ` (through ${b.imported})`;
  const message = `${b.importer} imports ${b.target}${via}, which the contract "${contract.name}" forbids.`;
  const file = moduleFile(b.importer, files, ctx.component.root);
  const location: Location | undefined =
    file === undefined || b.line === undefined ? undefined : { file, line: b.line };
  return location === undefined
    ? { rule, message, key: `${contract.name}: ${b.importer} -> ${b.target}` }
    : { rule, message, location };
}

function contractFindings(ctx: Bound, judged: Judged, files: ReadonlySet<string>): Finding[] {
  if (judged.contract.imports.length === 0) {
    return [
      {
        rule: `import-linter/${judged.type}`,
        message: `The import-linter contract "${judged.contract.name}" is broken.`,
        key: judged.contract.name,
      },
    ];
  }
  return judged.contract.imports.map((b) => importFinding(ctx, judged, files, b));
}

async function lintImports(
  ctx: Bound,
  config: string,
  types: ReadonlyMap<string, string>,
): Promise<Finding[] | string> {
  const result = await runTool(ctx, 'lint-imports', [
    '--config',
    config,
    '--no-cache',
    '--no-logo',
  ]);
  const report = parseImportLinter(result.stdout);
  if (report === undefined) return tail(result, 5);
  const files = new Set(pythonFiles(ctx));
  return report.broken.flatMap((contract) =>
    contractFindings(ctx, { contract, type: types.get(contract.name) ?? 'contract' }, files),
  );
}

async function devOnly(ctx: Bound): Promise<string[]> {
  const lock = join(componentDir(ctx), 'uv.lock');
  if (!(await fileExists(lock))) return [];
  const devOnlyPackages = devOnlyDistributions(await readFile(lock, 'utf8'));
  return devOnlyPackages === undefined
    ? []
    : devOnlyModules(devOnlyPackages, await readEnvironment(ctx));
}

async function universal(ctx: Bound, roots: Roots): Promise<Finding[]> {
  const config = join(ctx.scratch, 'importlinter.toml');
  await writeFile(config, universalConfig(roots, await devOnly(ctx)));
  const found = await lintImports(ctx, config, UNIVERSAL_TYPES);
  if (typeof found === 'string') throw new EngineError(`lint-imports could not run:\n${found}`);
  return found;
}

/**
 * The universal contracts, which Talos writes for every package, then the project's own in
 * `[tool.importlinter]`. A project configuration that can't be read is a finding of its own.
 */
export async function arch(ctx: Bound): Promise<Finding[]> {
  const roots = packageRoots(pythonFiles(ctx));
  const findings = roots.shipped.length > 0 ? await universal(ctx, roots) : [];
  const own = (await pyprojectTool(componentDir(ctx))).importlinter;
  if (own === undefined) return findings;
  const found = await lintImports(ctx, 'pyproject.toml', contractTypes(own));
  if (typeof found !== 'string') return [...findings, ...found];
  const message = `import-linter could not check the contracts in pyproject.toml: ${found.split('\n').at(-1) ?? ''}`;
  return [
    ...findings,
    { rule: 'import-linter/config', message, key: inRepo(ctx.component.root, 'pyproject.toml') },
  ];
}

import { stringify } from 'smol-toml';
import { z } from 'zod';

/** A broken import: the first link of the chain, and where the chain ends. */
export type BrokenImport = {
  readonly importer: string;
  readonly imported: string;
  /** The module the chain finally reaches, when it runs through others. */
  readonly target: string;
  readonly line?: number;
};

export type BrokenContract = {
  readonly name: string;
  readonly imports: readonly BrokenImport[];
  /** For a cycle contract: the package whose children import each other. */
  readonly cycleIn?: string;
};

export type LintReport = { readonly kept: number; readonly broken: readonly BrokenContract[] };

const SUMMARY = /^Contracts: (\d+) kept, (\d+) broken\.$/m;
const LINK = /^(\S+) -> (\S+) \((.+)\)$/;

type Draft = { name: string; imports: BrokenImport[]; cycleIn?: string };

function link(text: string, cycleIn: string | undefined): BrokenImport | undefined {
  const match = LINK.exec(text.trim());
  if (match === null) return undefined;
  const [, from = '', to = '', where = ''] = match;
  const absolute = (name: string): string =>
    cycleIn !== undefined && name.startsWith('.') ? `${cycleIn}${name}` : name;
  const line = /l\.(\d+)/.exec(where)?.[1];
  return {
    importer: absolute(from),
    imported: absolute(to),
    target: absolute(to),
    ...(line === undefined ? {} : { line: Number(line) }),
  };
}

function readBodyLine(draft: Draft, raw: string): void {
  const cycle = /^No cycles are allowed in (\S+)\.$/.exec(raw.trim());
  if (cycle?.[1] !== undefined) {
    draft.cycleIn = cycle[1];
    return;
  }
  if (raw.startsWith('-')) {
    const found = link(raw.slice(1), draft.cycleIn);
    if (found) draft.imports.push(found);
    return;
  }
  const last = draft.imports.at(-1);
  const next = /^\s/.test(raw) ? link(raw, draft.cycleIn) : undefined;
  if (last && next) draft.imports[draft.imports.length - 1] = { ...last, target: next.imported };
}

function isHeading(lines: readonly string[], index: number): boolean {
  const title = lines[index] ?? '';
  const under = lines[index + 1] ?? '';
  return title.trim() !== '' && /^-+$/.test(under) && under.length === title.length;
}

function finish(draft: Draft): BrokenContract {
  return {
    name: draft.name,
    imports: draft.imports,
    ...(draft.cycleIn === undefined ? {} : { cycleIn: draft.cycleIn }),
  };
}

/**
 * Reads `lint-imports` output, which has no machine-readable form: the summary line, then under
 * "Broken contracts" each contract's name, underlined, and its chains as
 * `- a.b -> c.d (l.3)` with indented continuation links. Undefined when no summary was printed
 * (the configuration couldn't be read, or a package couldn't be imported).
 */
export function parseImportLinter(text: string): LintReport | undefined {
  const summary = SUMMARY.exec(text);
  if (summary === null) return undefined;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(
    (line, index) => line === 'Broken contracts' && isHeading(lines, index),
  );
  const broken: BrokenContract[] = [];
  let draft: Draft | undefined;
  let underline = start + 1;
  for (const [index, line] of lines.entries()) {
    if (start < 0 || index <= underline) continue;
    if (isHeading(lines, index)) {
      if (draft) broken.push(finish(draft));
      draft = { name: line, imports: [] };
      underline = index + 1;
    } else if (draft) readBodyLine(draft, line);
  }
  if (draft) broken.push(finish(draft));
  return { kept: Number(summary[1]), broken };
}

export type Roots = { readonly shipped: readonly string[]; readonly tests: readonly string[] };

const IDENTIFIER = /^[A-Za-z_]\w*$/;
const TEST_PACKAGES: ReadonlySet<string> = new Set(['tests', 'test']);

/**
 * The component's importable top-level packages, from its `__init__.py` files: under `src/`
 * when it has a src layout, at its root otherwise; `tests` and `test` are test code.
 */
export function packageRoots(files: readonly string[]): Roots {
  const at = (pattern: RegExp): string[] =>
    files.flatMap((file) => pattern.exec(file)?.[1] ?? []).filter((name) => IDENTIFIER.test(name));
  const src = at(/^src\/([^/]+)\/__init__\.py$/);
  const flat = at(/^([^/]+)\/__init__\.py$/);
  const tests = flat.filter((name) => TEST_PACKAGES.has(name));
  const shipped = src.length > 0 ? src : flat.filter((name) => !TEST_PACKAGES.has(name));
  return {
    shipped: [...new Set(shipped)].sort((a, b) => a.localeCompare(b)),
    tests: [...new Set(tests)].sort((a, b) => a.localeCompare(b)),
  };
}

export const UNIVERSAL = {
  cycles: 'No import cycles between the modules of a package',
  tests: 'Shipped code imports no test code',
  dev: 'Shipped code imports no dev-only dependency',
} as const;

export const UNIVERSAL_TYPES: ReadonlyMap<string, string> = new Map([
  [UNIVERSAL.cycles, 'acyclic_siblings'],
  [UNIVERSAL.tests, 'forbidden'],
  [UNIVERSAL.dev, 'forbidden'],
]);

/** The universal contracts as an import-linter configuration (TOML, read with `--config`). */
export function universalConfig(roots: Roots, devOnly: readonly string[]): string {
  const contracts: Record<string, unknown>[] = [
    { name: UNIVERSAL.cycles, type: 'acyclic_siblings', ancestors: [...roots.shipped] },
  ];
  if (roots.tests.length > 0) {
    contracts.push({
      name: UNIVERSAL.tests,
      type: 'forbidden',
      source_modules: [...roots.shipped],
      forbidden_modules: [...roots.tests],
    });
  }
  if (devOnly.length > 0) {
    contracts.push({
      name: UNIVERSAL.dev,
      type: 'forbidden',
      source_modules: [...roots.shipped],
      forbidden_modules: [...devOnly],
    });
  }
  const importlinter = {
    root_packages: [...roots.shipped, ...roots.tests],
    include_external_packages: devOnly.length > 0,
    contracts,
  };
  return stringify({ tool: { importlinter } });
}

const contract = z.object({ name: z.string(), type: z.string() });
const contracts = z.object({ contracts: z.array(z.unknown()) });

/** Contract names mapped to their types, from an `[tool.importlinter]` table. */
export function contractTypes(table: unknown): Map<string, string> {
  const types = new Map<string, string>();
  const parsed = contracts.safeParse(table);
  for (const entry of parsed.success ? parsed.data.contracts : []) {
    const one = contract.safeParse(entry);
    if (one.success) types.set(one.data.name, one.data.type);
  }
  return types;
}

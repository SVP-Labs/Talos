import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { firstLine } from './text.js';
import { EngineError } from '../core/check.js';

/** One file of a coverage report: hits per executable line, 0 for a line no test ran. */
export type RawFile = { readonly path: string; readonly hits: ReadonlyMap<number, number> };

export type RawCoverage = {
  readonly files: readonly RawFile[];
  /** Directories the report's relative paths may be relative to (Cobertura's `<source>`). */
  readonly sources: readonly string[];
};

export type FileLines = {
  readonly executable: ReadonlySet<number>;
  readonly covered: ReadonlySet<number>;
};

/** Repository-relative file → its executable lines and the covered ones among them. */
export type LineCoverage = ReadonlyMap<string, FileLines>;

function count(text: string | undefined, what: string): number {
  const value = Number(text);
  if (text === undefined || text.trim() === '' || !Number.isFinite(value)) {
    throw new EngineError(`a coverage report has ${what} "${text ?? ''}", which is not a number`);
  }
  return value;
}

function addHits(hits: Map<number, number>, line: number, value: number): void {
  if (!Number.isInteger(line) || line < 1) return;
  hits.set(line, (hits.get(line) ?? 0) + Math.max(0, value));
}

/** LCOV's `SF:` records and their `DA:<line>,<hits>` lines. */
export function parseLcov(text: string): RawCoverage {
  const files: RawFile[] = [];
  let current: Map<number, number> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = new Map();
      files.push({ path: line.slice(3).trim(), hits: current });
    } else if (line.startsWith('DA:') && current !== undefined) {
      const [number, hits] = line.slice(3).split(',');
      addHits(current, count(number, 'a line'), count(hits, 'a hit count'));
    } else if (line.trim() === 'end_of_record') {
      current = undefined;
    }
  }
  return { files, sources: [] };
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  isArray: (name) => ['source', 'package', 'class', 'line', 'file'].includes(name),
});

function parseXml(text: string, format: string): unknown {
  try {
    return xml.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EngineError(`a ${format} report is not XML: ${firstLine(reason)}`);
  }
}

/** An element that may be empty (`<lines/>`), which the parser reads as ''. */
function optional<T extends z.ZodType>(schema: T) {
  return z.union([z.literal(''), schema]).optional();
}

const coberturaLine = z.looseObject({ '@_number': z.string(), '@_hits': z.string() });
const coberturaClass = z.looseObject({
  '@_filename': z.string(),
  lines: optional(z.looseObject({ line: z.array(coberturaLine).optional() })),
});
const coberturaPackage = z.looseObject({
  classes: optional(z.looseObject({ class: z.array(coberturaClass).optional() })),
});
const cobertura = z.looseObject({
  coverage: z.looseObject({
    sources: optional(z.looseObject({ source: z.array(z.string()).optional() })),
    packages: optional(z.looseObject({ package: z.array(coberturaPackage).optional() })),
  }),
});

function present<T extends object>(value: T | '' | undefined): T | undefined {
  return value === '' ? undefined : value;
}

/**
 * Cobertura XML: each class's own `<lines>` (its methods' lines repeat them), merged per file.
 * Relative file names are relative to one of the `<source>` directories.
 */
export function parseCobertura(text: string): RawCoverage {
  const parsed = cobertura.safeParse(parseXml(text, 'Cobertura'));
  if (!parsed.success) throw new EngineError('a Cobertura report has an unexpected shape');
  const report = parsed.data.coverage;
  const packages = present(report.packages)?.package ?? [];
  const files = packages.flatMap((pack) =>
    (present(pack.classes)?.class ?? []).map((entry): RawFile => {
      const hits = new Map<number, number>();
      for (const line of present(entry.lines)?.line ?? []) {
        addHits(hits, count(line['@_number'], 'a line'), count(line['@_hits'], 'a hit count'));
      }
      return { path: entry['@_filename'], hits };
    }),
  );
  const sources = (present(report.sources)?.source ?? []).map((source) => source.trim());
  return { files, sources };
}

const cloverLine = z.looseObject({
  '@_num': z.string(),
  '@_count': z.string(),
  '@_type': z.string().optional(),
});
const cloverFile = z.looseObject({
  '@_name': z.string(),
  '@_path': z.string().optional(),
  line: z.array(cloverLine).optional(),
});
const cloverProject = z.looseObject({
  file: z.array(cloverFile).optional(),
  package: z.array(z.looseObject({ file: z.array(cloverFile).optional() })).optional(),
});
const clover = z.looseObject({ coverage: z.looseObject({ project: cloverProject }) });

/**
 * Clover XML (Istanbul's and PHPUnit's): statement and condition lines. A `method` line is a
 * declaration, whose body's statements are counted on their own lines.
 */
export function parseClover(text: string): RawCoverage {
  const parsed = clover.safeParse(parseXml(text, 'Clover'));
  if (!parsed.success) throw new EngineError('a Clover report has an unexpected shape');
  const project = parsed.data.coverage.project;
  const entries = [
    ...(project.file ?? []),
    ...(project.package ?? []).flatMap((p) => p.file ?? []),
  ];
  const files = entries.map((entry): RawFile => {
    const hits = new Map<number, number>();
    for (const line of entry.line ?? []) {
      if (line['@_type'] === 'method') continue;
      addHits(hits, count(line['@_num'], 'a line'), count(line['@_count'], 'a hit count'));
    }
    return { path: entry['@_path'] ?? entry['@_name'], hits };
  });
  return { files, sources: [] };
}

type MutableLines = { executable: Set<number>; covered: Set<number> };

function entryFor(map: Map<string, MutableLines>, file: string): MutableLines {
  let entry = map.get(file);
  if (entry === undefined) {
    entry = { executable: new Set(), covered: new Set() };
    map.set(file, entry);
  }
  return entry;
}

/**
 * The report's files under their repository-relative names, merged where several names reach
 * one file; `locate` drops a file (outside the repository, untracked, excluded) by returning
 * undefined.
 */
export function toLineCoverage(
  raw: RawCoverage,
  locate: (path: string, sources: readonly string[]) => string | undefined,
): Map<string, FileLines> {
  const map = new Map<string, MutableLines>();
  for (const file of raw.files) {
    const repo = locate(file.path, raw.sources);
    if (repo === undefined) continue;
    const entry = entryFor(map, repo);
    for (const [line, hits] of file.hits) {
      entry.executable.add(line);
      if (hits > 0) entry.covered.add(line);
    }
  }
  return map;
}

/** Two runs' coverage together: a line either run executed is covered. */
export function mergeCoverage(first: LineCoverage, second: LineCoverage): Map<string, FileLines> {
  const map = new Map<string, MutableLines>();
  for (const coverage of [first, second]) {
    for (const [file, lines] of coverage) {
      const entry = entryFor(map, file);
      for (const line of lines.executable) entry.executable.add(line);
      for (const line of lines.covered) entry.covered.add(line);
    }
  }
  return map;
}

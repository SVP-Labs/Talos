import { stringify } from 'yaml';
import { type Lock, namespacesOf } from './composer.js';
import { generatedHeader } from '../../configs/header.js';

export const DEPTRAC_BASE = 'deptrac.yaml';
export const DEPTRAC_PROJECT = 'deptrac.project.yaml';

/** PCRE-escaped, for a pattern between `#` delimiters. */
export function escapePcre(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\#/-]/g, String.raw`\$&`);
}

/**
 * Test code by path, as Talos classifies it: a `tests` or `test` directory, or a `*Test.php` file.
 * deptrac matches it case-insensitively against absolute paths; `(?-i)` makes it exact.
 */
export function testPattern(dir?: string): string {
  const start = dir === undefined ? '(^|/)' : `^${escapePcre(dir)}/(.*/)?`;
  return String.raw`(?-i)${start}tests?/|Test\.php$`;
}

export type DeptracOptions = {
  readonly paths: readonly string[];
  /** Regular expressions with delimiters, as deptrac's `exclude_files` takes them. */
  readonly excludeFiles: readonly string[];
  readonly tests: string;
  /** Namespace prefixes only `require-dev` brings; the gate knows them from composer.lock. */
  readonly devPrefixes?: readonly string[];
};

/**
 * The universal rules, which deptrac runs apart from the project's own layers: a class that
 * belongs to two layers is checked against both rulesets, so the two can't share one config.
 * Shipped code is in no ruleset, so it may depend on no other layer.
 */
export function deptracConfig(options: DeptracOptions): Record<string, unknown> {
  const prefixes = options.devPrefixes ?? [];
  const dev =
    prefixes.length === 0
      ? []
      : [
          {
            name: 'DevDependencies',
            collectors: [
              {
                type: 'classNameRegex',
                value: `#^(?:${prefixes.map((p) => escapePcre(p)).join('|')})#`,
              },
            ],
          },
        ];
  return {
    deptrac: {
      paths: [...options.paths],
      exclude_files: [...options.excludeFiles],
      layers: [
        { name: 'Tests', collectors: [{ type: 'directory', value: options.tests }] },
        {
          name: 'Shipped',
          collectors: [
            {
              type: 'bool',
              must: [{ type: 'directory', value: '.*' }],
              must_not: [{ type: 'layer', value: 'Tests' }],
            },
          ],
        },
        ...dev,
      ],
      ruleset: { Tests: ['Shipped', ...dev.map((layer) => layer.name)] },
    },
  };
}

/** The committed base, which editors and `vendor/bin/deptrac` read; the gate adds dev packages. */
export function renderDeptracBase(version: string): string {
  const config = deptracConfig({
    paths: ['.'],
    excludeFiles: ['#(^|/)(vendor|node_modules)/#', String.raw`#\.blade\.php$#`],
    tests: testPattern(),
  });
  const note =
    `# The project's own layers go in ${DEPTRAC_PROJECT}, which Talos runs on its own;\n` +
    '# the gate also forbids shipped code any package only require-dev brings.\n';
  return generatedHeader('#', version) + note + stringify(config);
}

const CLASSMAP_ENTRY = /^\s*'((?:[^'\\]|\\.)+)' => \$vendorDir \. '\/([^/']+\/[^/']+)\//;

/** The classes each package's classmap holds, from Composer's `autoload_classmap.php`. */
export function classmapClasses(text: string): ReadonlyMap<string, string[]> {
  const classes = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const match = CLASSMAP_ENTRY.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const name = match[1].replaceAll('\\\\', '\\');
    classes.set(match[2], [...(classes.get(match[2]) ?? []), name]);
  }
  return classes;
}

/** The namespace every class shares, with its trailing separator; undefined when none. */
export function commonNamespace(names: readonly string[]): string | undefined {
  const spaces = names.map((name) => name.split('\\').slice(0, -1));
  const [first, ...rest] = spaces;
  if (first === undefined) return undefined;
  let length = first.length;
  for (const space of rest) {
    let shared = 0;
    while (shared < Math.min(length, space.length) && space[shared] === first[shared]) shared += 1;
    length = shared;
  }
  return length === 0 ? undefined : `${first.slice(0, length).join('\\')}\\`;
}

function overlaps(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * The namespace prefixes of packages only `require-dev` brings (Composer's `packages-dev`): their
 * PSR-4 and PSR-0 prefixes, and for a classmap package the namespace all its classes share. A
 * prefix that overlaps one of `own` (the project's and its other packages') is left out: a tool
 * shipped as a phar can still declare an application's namespaces, as pint does `App\`.
 */
export function devPrefixes(
  lock: Lock,
  classmap: ReadonlyMap<string, string[]>,
  own: readonly string[],
): string[] {
  const shipped = [...own, ...lock.packages.flatMap((pkg) => namespacesOf(pkg.autoload))];
  const prefixes = lock['packages-dev'].flatMap((pkg) => {
    const fromMap = commonNamespace(classmap.get(pkg.name) ?? []);
    return [...namespacesOf(pkg.autoload), ...(fromMap === undefined ? [] : [fromMap])];
  });
  return [...new Set(prefixes)]
    .filter((prefix) => !shipped.some((name) => overlaps(prefix, name)))
    .sort((a, b) => a.localeCompare(b));
}

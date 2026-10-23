import { posix, relative, sep } from 'node:path';
import { z } from 'zod';
import { satisfies } from './licences.js';
import { EngineError } from '../../core/check.js';
import type { Finding } from '../../core/finding.js';
import type { Locked } from '../supply/lockfiles/index.js';

const vulnerability = z.looseObject({
  id: z.string(),
  summary: z.string().default(''),
  database_specific: z.looseObject({ severity: z.unknown().optional() }).optional(),
  affected: z
    .array(
      z.looseObject({
        package: z.looseObject({ name: z.string() }).optional(),
        ranges: z
          .array(
            z.looseObject({ events: z.array(z.looseObject({ fixed: z.string().optional() })) }),
          )
          .default([]),
      }),
    )
    .default([]),
});

const group = z.looseObject({
  ids: z.array(z.string()),
  aliases: z.array(z.string()).default([]),
  max_severity: z.string().default(''),
});

const scanned = z.looseObject({
  package: z.looseObject({
    name: z.string(),
    version: z.string().default(''),
    ecosystem: z.string().default(''),
  }),
  groups: z.array(group).default([]),
  vulnerabilities: z.array(vulnerability).default([]),
  license_violations: z.array(z.string()).default([]),
});

const output = z.looseObject({
  results: z
    .array(
      z.looseObject({
        source: z.looseObject({ path: z.string() }),
        packages: z.array(scanned).default([]),
      }),
    )
    .default([]),
});

export type Advisory = {
  readonly id: string;
  readonly severe: boolean;
  readonly summary: string;
  readonly fixed: readonly string[];
};

export type ScannedPackage = {
  /** Repository-relative. */
  readonly lockfile: string;
  readonly name: string;
  readonly version: string;
  readonly ecosystem: string;
  readonly advisories: readonly Advisory[];
  readonly licenceViolations: readonly string[];
};

type Scanned = z.infer<typeof scanned>;

/** A group's own id: the GitHub advisory when it has one, so exceptions name what people see. */
function groupId(found: z.infer<typeof group>): string {
  const ids = [...found.ids].sort((a, b) => a.localeCompare(b));
  return ids.find((id) => id.startsWith('GHSA-')) ?? ids[0] ?? 'unknown';
}

/** High or critical: GitHub's rating says so, or the CVSS score is 7.0 or more. */
function severe(found: z.infer<typeof group>, vulns: readonly z.infer<typeof vulnerability>[]) {
  const rated = vulns.some((vuln) => {
    const rating = vuln.database_specific?.severity;
    return rating === 'HIGH' || rating === 'CRITICAL';
  });
  const score = Number.parseFloat(found.max_severity);
  return rated || (Number.isFinite(score) && score >= 7);
}

function advisoryOf(found: z.infer<typeof group>, pkg: Scanned): Advisory {
  const members = new Set([...found.ids, ...found.aliases]);
  const vulns = pkg.vulnerabilities.filter((vuln) => members.has(vuln.id));
  const fixed = vulns
    .flatMap((vuln) => vuln.affected)
    .filter((entry) => entry.package?.name === pkg.package.name)
    .flatMap((entry) => entry.ranges.flatMap((range) => range.events))
    .flatMap((event) => (event.fixed === undefined ? [] : [event.fixed]));
  return {
    id: groupId(found),
    severe: severe(found, vulns),
    summary: vulns.find((vuln) => vuln.summary !== '')?.summary ?? '',
    fixed: [...new Set(fixed)],
  };
}

/** osv-scanner's JSON report, with each lockfile's path made repository-relative. */
export function parseOsvReport(text: string, root: string): ScannedPackage[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError("osv-scanner's report is not JSON");
  }
  const parsed = output.safeParse(raw);
  if (!parsed.success) throw new EngineError("osv-scanner's report is not in the expected form");
  return parsed.data.results.flatMap((result) => {
    const lockfile = relative(root, result.source.path).split(sep).join(posix.sep);
    return result.packages.map((pkg) => ({
      lockfile,
      name: pkg.package.name,
      version: pkg.package.version,
      ecosystem: pkg.package.ecosystem,
      advisories: pkg.groups.map((found) => advisoryOf(found, pkg)),
      licenceViolations: pkg.license_violations,
    }));
  });
}

/** What the lockfile says about a scanned package, to tell the project's own code from others'. */
export type LockedLookup = (lockfile: string, name: string, version: string) => Locked | undefined;

function sentence(text: string): string {
  return text.trim().replace(/\.$/, '');
}

export function vulnerabilityFinding(pkg: ScannedPackage, advisory: Advisory): Finding {
  const about = advisory.summary === '' ? '' : `, ${sentence(advisory.summary)}`;
  const fix =
    advisory.fixed.length === 0 ? 'no fixed release yet' : `fixed in ${advisory.fixed.join(', ')}`;
  return {
    rule: `osv/${advisory.id}`,
    key: `${pkg.name}@${pkg.version} ${advisory.id}`,
    message: `${pkg.name} ${pkg.version} in ${pkg.lockfile} is affected by ${advisory.id}${about}; ${fix}.`,
    ...(advisory.severe ? { policy: 'always' } : {}),
  };
}

function licenceFinding(pkg: ScannedPackage, licence: string): Finding {
  return {
    rule: `licence/${licence}`,
    key: `${pkg.name}@${pkg.version} ${licence}`,
    message: `${pkg.name} ${pkg.version} in ${pkg.lockfile} is licensed ${licence}, which neither the org's allowlist nor talos.yml's licences allow.`,
  };
}

/**
 * Licence findings for a package from a registry. osv-scanner knows no licence for some
 * registries' packages (Packagist's); where the lockfile records one, it is judged instead.
 */
function licenceFindings(
  pkg: ScannedPackage,
  locked: Locked | undefined,
  allowed: readonly string[],
): Finding[] {
  if (pkg.ecosystem === 'GIT' || (locked !== undefined && locked.source.kind !== 'registry')) {
    return [];
  }
  return pkg.licenceViolations.flatMap((licence) => {
    const recorded = licence === 'UNKNOWN' ? (locked?.licences ?? []) : [];
    if (recorded.length === 0) return [licenceFinding(pkg, licence)];
    if (recorded.some((own) => satisfies(own, allowed))) return [];
    return [licenceFinding(pkg, recorded.join(' OR '))];
  });
}

/**
 * Advisories and licences for every scanned package but the repository's own: a workspace
 * member's name can match an unrelated registry package's.
 */
export function dependencyFindings(
  packages: readonly ScannedPackage[],
  lookup: LockedLookup,
  allowed: readonly string[],
): Finding[] {
  return packages.flatMap((pkg) => {
    const locked = lookup(pkg.lockfile, pkg.name, pkg.version);
    if (locked?.source.kind === 'local') return [];
    return [
      ...pkg.advisories.map((advisory) => vulnerabilityFinding(pkg, advisory)),
      ...licenceFindings(pkg, locked, allowed),
    ];
  });
}

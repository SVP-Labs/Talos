import { isDeclaringFile } from '../checks/runtime/declarations.js';
import type { Finding } from '../core/finding.js';
import type { IssueDraft } from '../jobs/talos-issues.js';
import { markerFields } from '../status/markers.js';
import { LABEL } from '../ticket/labels.js';

/**
 * The hourly runtime sweep's decisions: which files to read, which findings are security
 * releases, and the one issue per vulnerable runtime that reaches Thea as an event. Pure; the
 * effects live in `sweep-job.ts`.
 */

const SECURITY_RULE = 'runtime/security';
const SECURITY_MARKER = 'talos-security/1';
export const SECURITY_LABEL = 'security';
const P0_LABEL = 'priority/p0';
const TOOLS_LOCK = 'tools.lock';
const CONFIG = 'talos.yml';

/** At most this many files are read from one repository per sweep. */
export const MAX_FILES = 60;

/**
 * Whether the sweep reads a path: every file the gate's runtime check reads, and the root
 * `talos.yml`, whose `exclude` and exceptions that check honours.
 */
export function isRuntimeFile(path: string): boolean {
  return path === CONFIG || isDeclaringFile(path);
}

export type RuntimeAlert = {
  readonly runtime: string;
  readonly version: string;
  /** The security release of the version's cycle; `unknown` when the finding didn't name it. */
  readonly fixed: string;
  readonly file: string | null;
};

const WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const VERSION = /^\d+(?:\.\d+)+$/;
const VERSIONS_IN_TEXT = /\b\d+(?:\.\d+)+\b/g;

function parts(version: string): number[] {
  return version.split('.').map(Number);
}

/** Numeric order of dotted versions; a shorter one sorts first on a tie. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? -1) - (y[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest version a message names beside `version`, with as many parts. */
function fixedIn(message: string, version: string): string | undefined {
  const width = parts(version).length;
  return [...message.matchAll(VERSIONS_IN_TEXT)]
    .map((match) => match[0])
    .filter((v) => v !== version && parts(v).length === width)
    .sort(compareVersions)
    .at(-1);
}

/**
 * A `runtime/security` finding as an alert. Its key is `<runtime> <version>`, optionally followed
 * by the fixed version; otherwise the fixed version is the newest one its message names.
 */
export function alertOf(finding: Finding): RuntimeAlert | undefined {
  if (finding.rule !== SECURITY_RULE) return undefined;
  const [runtime = '', version = '', ...rest] = (finding.key ?? '').trim().split(/\s+/);
  if (!WORD.test(runtime) || !VERSION.test(version)) return undefined;
  const named = rest.find((word) => VERSION.test(word));
  const fixed = named ?? fixedIn(finding.message, version) ?? 'unknown';
  return { runtime: runtime.toLowerCase(), version, fixed, file: finding.location?.file ?? null };
}

export type AlertGroup = {
  readonly runtime: string;
  readonly version: string;
  readonly fixed: string;
  readonly files: readonly string[];
};

/** Code-point order, the same on every machine whatever its locale. */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function newer(a: string, b: string): string {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

/** One group per runtime and declared version, naming every file that declares it. */
export function groupAlerts(alerts: readonly RuntimeAlert[]): AlertGroup[] {
  const groups = new Map<string, { fixed: string; files: Set<string>; alert: RuntimeAlert }>();
  for (const alert of alerts) {
    const key = `${alert.runtime} ${alert.version}`;
    const group = groups.get(key) ?? { fixed: alert.fixed, files: new Set(), alert };
    group.fixed = newer(group.fixed, alert.fixed);
    if (alert.file !== null) group.files.add(alert.file);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ fixed, files, alert }) => ({
      runtime: alert.runtime,
      version: alert.version,
      fixed,
      files: [...files].sort(byCodePoint),
    }))
    .sort((a, b) => byCodePoint(`${a.runtime} ${a.version}`, `${b.runtime} ${b.version}`));
}

/** The issue's first line, which Thea's hub turns into an event: a p0 jumps her budget. */
export function securityLine(group: AlertGroup): string {
  const { runtime, version, fixed } = group;
  return `${SECURITY_MARKER} kind=runtime runtime=${runtime} version=${version} fixed=${fixed} priority=p0`;
}

/** The fields of a body's `talos-security/1` first line, or `undefined` without one. */
export function readSecurityLine(body: string): Readonly<Record<string, string>> | undefined {
  return markerFields(body, SECURITY_MARKER);
}

export type OpenSecurityIssue = { readonly body: string };

/** The groups no open security issue of Talos's covers yet: same runtime, same version. */
export function unfiled(
  groups: readonly AlertGroup[],
  open: readonly OpenSecurityIssue[],
): AlertGroup[] {
  const filed = new Set(
    open.flatMap((issue) => {
      const fields = readSecurityLine(issue.body);
      return fields?.kind === 'runtime' ? [`${fields.runtime ?? ''} ${fields.version ?? ''}`] : [];
    }),
  );
  return groups.filter((group) => !filed.has(`${group.runtime} ${group.version}`));
}

function pathItem(path: string): string {
  return /^[^\s`]+$/.test(path) ? `- \`${path}\`` : '- (a file whose name needs quoting)';
}

/** The security issue for one runtime: ready to claim, its first line machine-readable. */
export function securityIssue(group: AlertGroup): IssueDraft {
  const { runtime, version, fixed } = group;
  const target = fixed === 'unknown' ? 'its cycle’s latest security release' : fixed;
  const locked = group.files.includes(TOOLS_LOCK);
  const body = [
    securityLine(group),
    '',
    '### Goal',
    '',
    `Move ${runtime} ${version} to ${target}, wherever this repository declares it: a newer ` +
      'patch of its cycle is a security release.',
    '',
    '### Acceptance criteria',
    '',
    `- [ ] Every file below declares ${runtime} ${target} or later in the same cycle`,
    '- [ ] `talos check` reports no `runtime/security` finding',
    '',
    '### Out of scope',
    '',
    'Other runtimes, dependency updates and every other finding.',
    '',
    '### Affected areas',
    '',
    ...(group.files.length > 0 ? group.files.map(pathItem) : ['- the runtime declarations']),
    '',
    '### Repro',
    '',
    "Talos's hourly runtime sweep compared these declarations with the vendor's release feed.",
    '',
    '### Expected / Actual',
    '',
    `Expected: ${runtime} ${target}. Actual: ${runtime} ${version}.`,
    ...(locked
      ? [
          '',
          '`tools.lock` pins this runtime for every repository Talos governs: the fix ships in a ' +
            'Talos release, which the owner promotes through the urgent path.',
        ]
      : []),
    '',
  ].join('\n');
  return {
    title: `Security release: ${runtime} ${version} needs ${fixed === 'unknown' ? 'a patch' : fixed}`,
    body,
    labels: [LABEL.bug, SECURITY_LABEL, P0_LABEL, LABEL.ready, LABEL.eligible],
  };
}

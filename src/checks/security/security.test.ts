import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  probeConfig,
  readGitleaksProject,
  redefinitions,
  renderGitleaksBase,
  scanConfig,
} from './gitleaks-config.js';
import { parseGitleaksReport } from './gitleaks.js';
import { securityPack } from './index.js';
import { allowedLicences, satisfies } from './licences.js';
import { renderOsvConfig } from './osv-config.js';
import { dependencyFindings, parseOsvReport, type ScannedPackage } from './osv.js';
import { firstSentence, parseSemgrep, renderSemgrepignore, semgrepConfigs } from './semgrep.js';
import { parseConfig } from '../../config/load.js';
import { EngineError } from '../../core/check.js';
import { runChecks } from '../../engine/run.js';
import { repoFacts } from '../../repo/facts.js';
import { MINIMAL_CONFIG, tempRepo, testEngine, testPlan } from '../../testing/engine.js';
import type { Locked } from '../supply/lockfiles/index.js';

// Recorded from gitleaks 8.30.1 with the report template, over a repository with a Slack
// token and a project rule's token committed.
const GITLEAKS_REPORT = `[
{"rule":"slack-bot-token","file":"more.ts","line":2,"commit":"4a812074f0c063e0ccc4976fae9c73febc9c41d8","hash":"cc6589719cb48effb43e7b4b43e06cac0333e3bb108f722723df664e7eb94179"},
{"rule":"talos-test-token","file":"leak.ts","line":1,"commit":"ccf91ac62c25b9d6ac87f6e5e15df5eb72103c56","hash":"aca6116df658b7d16a290c3676841e7fcaa42467ac90e9a74ddcdfaab266484e"}
]
`;

// Recorded from osv-scanner 2.7.0 over a package-lock.json, trimmed to two advisories.
const OSV_REPORT = JSON.stringify({
  results: [
    {
      source: { path: '/repo/package-lock.json', type: 'lockfile' },
      packages: [
        {
          package: { name: 'left-pad', version: '1.3.0', ecosystem: 'npm' },
          licenses: ['WTFPL'],
          license_violations: ['WTFPL'],
        },
        {
          package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
          groups: [
            {
              ids: ['GHSA-29mw-wpgm-hmr9'],
              aliases: ['CVE-2020-28500', 'GHSA-29mw-wpgm-hmr9'],
              max_severity: '5.3',
            },
            {
              ids: ['GHSA-35jh-r3h4-6jhm'],
              aliases: ['CVE-2021-23337', 'GHSA-35jh-r3h4-6jhm'],
              max_severity: '7.2',
            },
          ],
          vulnerabilities: [
            {
              id: 'GHSA-29mw-wpgm-hmr9',
              summary: 'Regular Expression Denial of Service (ReDoS) in lodash',
              database_specific: { severity: 'MODERATE' },
              affected: [
                {
                  package: { ecosystem: 'npm', name: 'lodash' },
                  ranges: [{ events: [{ introduced: '4.0.0' }, { fixed: '4.17.21' }] }],
                },
                {
                  package: { ecosystem: 'npm', name: 'lodash-es' },
                  ranges: [{ events: [{ introduced: '4.0.0' }, { fixed: '4.17.22' }] }],
                },
              ],
            },
            {
              id: 'GHSA-35jh-r3h4-6jhm',
              summary: 'Command Injection in lodash',
              database_specific: { severity: 'HIGH' },
              affected: [
                {
                  package: { ecosystem: 'npm', name: 'lodash' },
                  ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
                },
              ],
            },
          ],
          license_violations: [],
        },
      ],
    },
    {
      source: { path: '/repo/php/composer.lock', type: 'lockfile' },
      packages: [
        {
          package: { name: 'psr/log', version: '3.0.2', ecosystem: 'Packagist' },
          license_violations: ['UNKNOWN'],
        },
        {
          package: { name: 'acme/own', version: 'dev-main', ecosystem: 'Packagist' },
          license_violations: ['UNKNOWN'],
        },
      ],
    },
  ],
});

// Recorded from Semgrep 1.182.1 (p/default, p/python), trimmed.
const SEMGREP = JSON.stringify({
  version: '1.182.1',
  results: [
    {
      check_id: 'python.lang.security.audit.subprocess-shell-true.subprocess-shell-true',
      path: 'app.py',
      start: { line: 5, col: 32, offset: 78 },
      end: { line: 5, col: 36, offset: 82 },
      extra: {
        message:
          "Found 'subprocess' function 'call' with 'shell=True'. This is dangerous because this\ncall will spawn the command using a shell process.",
        metadata: { shortlink: 'https://sg.run/J92w', source: 'https://semgrep.dev/r/x' },
        severity: 'ERROR',
        fingerprint: 'requires login',
        lines: 'requires login',
      },
    },
  ],
  errors: [{ code: 3, level: 'warn', type: ['PartialParsing'], message: 'Syntax error' }],
  paths: { scanned: ['app.py'] },
});

describe('gitleaks', () => {
  it('reads its report as findings keyed by the hashed secret, never the commit or line', () => {
    const findings = parseGitleaksReport(GITLEAKS_REPORT);
    expect(findings[0]).toEqual({
      rule: 'gitleaks/slack-bot-token',
      key: 'slack-bot-token cc6589719cb48eff',
      message:
        'A secret (slack-bot-token) was committed to more.ts at line 2 in 4a812074; revoke it, then remove it.',
    });
    expect(findings).toHaveLength(2);
    expect(parseGitleaksReport('[]\n')).toEqual([]);
    expect(() => parseGitleaksReport('[{"rule":1}]')).toThrow(EngineError);
    expect(() => parseGitleaksReport('not json')).toThrow(/not JSON/);
  });

  it('renders a base that extends the project file', () => {
    const base = renderGitleaksBase('1.2.3');
    expect(base.split('\n')[0]).toBe(
      '# Generated by Talos 1.2.3. Do not edit: extend it in .gitleaks.project.toml, which may only tighten it.',
    );
    expect(parse(base)).toEqual({ title: 'Talos', extend: { path: '.gitleaks.project.toml' } });
  });

  it("finds what weakens gitleaks' defaults in the project file", () => {
    expect(readGitleaksProject('[extend]\nuseDefault = true\n').faults).toEqual([]);
    const weak = readGitleaksProject(
      [
        '[extend]',
        'useDefault = true',
        'disabledRules = ["generic-api-key"]',
        '[[allowlists]]',
        'paths = [".*"]',
        '[[rules]]',
        'id = "own"',
        "regex = '''own_[a-z]{8}'''",
        '[[rules.allowlists]]',
        "regexes = ['''own_test''']",
      ].join('\n'),
    );
    expect(weak.faults.map((w) => w.key)).toEqual(['disabled generic-api-key', 'global allowlist']);
    expect(weak.rules.map((rule) => rule.id)).toEqual(['own']);
    expect(readGitleaksProject('').faults.map((w) => w.key)).toEqual(['useDefault']);
    expect(readGitleaksProject('[extend]\npath = "x.toml"').faults.map((w) => w.key)).toEqual([
      'useDefault',
      'extend',
    ]);
    expect(readGitleaksProject('[[rules]').faults.map((w) => w.key)).toEqual(['unreadable']);
    expect(redefinitions(new Set(['aws-access-token']))[0]?.how).toMatch(/redefines/);
  });

  it('scans with the defaults and the project rules, and probes a rule id', () => {
    const rules = readGitleaksProject(
      "[extend]\nuseDefault = false\n[[rules]]\nid = \"own\"\nregex = '''a\\\\b'''\n",
    ).rules;
    expect(parse(scanConfig(rules))).toEqual({
      title: 'Talos',
      extend: { useDefault: true },
      rules: [{ id: 'own', regex: String.raw`a\\b` }],
    });
    expect(parse(probeConfig('aws-access-token'))).toMatchObject({
      allowlists: [{ targetRules: ['aws-access-token'] }],
    });
  });
});

describe('osv-scanner', () => {
  const packages = parseOsvReport(OSV_REPORT, '/repo');
  const locked: Locked[] = [
    {
      ecosystem: 'packagist',
      name: 'psr/log',
      version: '3.0.2',
      source: { kind: 'registry', public: true },
      licences: ['MIT'],
    },
    { ecosystem: 'packagist', name: 'acme/own', version: 'dev-main', source: { kind: 'local' } },
  ];
  const lookup = (lockfile: string, name: string, version: string) =>
    lockfile === 'php/composer.lock'
      ? locked.find((l) => l.name === name && l.version === version)
      : undefined;

  it('reads the report with repository-relative lockfiles and grouped advisories', () => {
    const lodash = packages.find((p) => p.name === 'lodash');
    expect(lodash?.lockfile).toBe('package-lock.json');
    expect(lodash?.advisories).toEqual([
      {
        id: 'GHSA-29mw-wpgm-hmr9',
        severe: false,
        summary: 'Regular Expression Denial of Service (ReDoS) in lodash',
        fixed: ['4.17.21'],
      },
      {
        id: 'GHSA-35jh-r3h4-6jhm',
        severe: true,
        summary: 'Command Injection in lodash',
        fixed: ['4.17.21'],
      },
    ]);
    expect(() => parseOsvReport('{', '/repo')).toThrow(EngineError);
  });

  it('fails high and critical advisories always, and judges licences', () => {
    const findings = dependencyFindings(packages, lookup, ['MIT']);
    expect(findings.map((f) => [f.rule, f.key, f.policy])).toEqual([
      ['licence/WTFPL', 'left-pad@1.3.0 WTFPL', undefined],
      ['osv/GHSA-29mw-wpgm-hmr9', 'lodash@4.17.20 GHSA-29mw-wpgm-hmr9', undefined],
      ['osv/GHSA-35jh-r3h4-6jhm', 'lodash@4.17.20 GHSA-35jh-r3h4-6jhm', 'always'],
    ]);
    expect(findings[2]?.message).toBe(
      'lodash 4.17.20 in package-lock.json is affected by GHSA-35jh-r3h4-6jhm, Command Injection in lodash; fixed in 4.17.21.',
    );
    const strict = dependencyFindings(packages, lookup, ['ISC']).map((f) => f.rule);
    expect(strict).toContain('licence/MIT');
  });

  it('knows a package with an unknown licence and no lockfile record', () => {
    const lone: ScannedPackage = {
      lockfile: 'Cargo.lock',
      name: 'x',
      version: '1.0.0',
      ecosystem: 'crates.io',
      advisories: [],
      licenceViolations: ['UNKNOWN'],
    };
    expect(dependencyFindings([lone], () => undefined, ['MIT']).map((f) => f.rule)).toEqual([
      'licence/UNKNOWN',
    ]);
    expect(dependencyFindings([{ ...lone, ecosystem: 'GIT' }], () => undefined, [])).toEqual([]);
  });

  it('renders the exceptions as its ignore list', () => {
    const config = parseConfig(
      `${MINIMAL_CONFIG}supply_chain:\n  exceptions:\n    GHSA-aaaa-bbbb-cccc: { reason: 'dev only, "never" shipped', expires: 2026-11-15 }\n`,
    );
    const rendered = renderOsvConfig(config, '1.0.0');
    expect(rendered.startsWith('# Generated by Talos 1.0.0. Do not edit.\n')).toBe(true);
    const [ignored] = z
      .object({ IgnoredVulns: z.array(z.record(z.string(), z.unknown())) })
      .parse(parse(rendered)).IgnoredVulns;
    expect(ignored).toMatchObject({
      id: 'GHSA-aaaa-bbbb-cccc',
      reason: 'dev only, "never" shipped',
    });
    expect(rendered).toContain('\nignoreUntil = 2026-11-15\n');
  });

  it('allows the org licences, the project additions and SPDX expressions', () => {
    const allowed = allowedLicences(
      parseConfig(`${MINIMAL_CONFIG}licences: { MPL-2.0: a parser }\n`),
    );
    expect(allowed).toContain('MPL-2.0');
    expect(allowed).toContain('Apache-2.0');
    expect(satisfies('(MIT OR GPL-3.0-only)', allowed)).toBe(true);
    expect(satisfies('MIT AND GPL-3.0-only', allowed)).toBe(false);
    expect(satisfies('mit', allowed)).toBe(true);
  });
});

describe('semgrep', () => {
  it("picks the rule sets for a repository's languages and tools", () => {
    const facts = repoFacts(
      ['src/a.tsx', 'app/main.py', 'Dockerfile', '.github/workflows/ci.yml'],
      [],
    );
    expect(semgrepConfigs(facts)).toEqual([
      'p/default',
      'p/security-audit',
      'p/owasp-top-ten',
      'p/secrets',
      'p/javascript',
      'p/typescript',
      'p/nodejs',
      'p/react',
      'p/python',
      'p/dockerfile',
      'p/github-actions',
    ]);
  });

  it('reads its report, one sentence per message', () => {
    expect(parseSemgrep(SEMGREP)).toEqual([
      {
        rule: 'semgrep/python.lang.security.audit.subprocess-shell-true.subprocess-shell-true',
        message: "Found 'subprocess' function 'call' with 'shell=True'.",
        location: { file: 'app.py', line: 5, endLine: 5, column: 32 },
        docs: 'https://sg.run/J92w',
      },
    ]);
    expect(firstSentence('Detected eval(). It is bad.')).toBe('Detected eval().');
    expect(firstSentence('no stop')).toBe('no stop');
  });

  it('fails on an error that stops the scan', () => {
    const failed = JSON.stringify({
      results: [],
      errors: [{ level: 'error', message: 'Failed to download configuration. HTTP 404.' }],
    });
    expect(() => parseSemgrep(failed)).toThrow(/Failed to download configuration\./);
    expect(() => parseSemgrep('nope')).toThrow(EngineError);
  });

  it("skips only talos.yml's exclude, anchored at the root", () => {
    expect(renderSemgrepignore(['vendor/', 'app'], '1.0.0').split('\n').slice(2)).toEqual([
      '/vendor/',
      '/app',
      '',
    ]);
  });
});

describe('security/config-strength', () => {
  it('finds ignore files below the root and a project file that drops the defaults', async () => {
    const files = {
      '.gitleaks.project.toml': '[allowlist]\npaths = [".*"]\n',
      'apps/x/osv-scanner.toml': '[[IgnoredVulns]]\nid = "GHSA-x"\n',
      'osv-scanner.toml': '# generated\n',
      'apps/x/.semgrepignore': '*.py\n',
    };
    const root = await tempRepo(files);
    const result = await runChecks(testEngine([securityPack]), {
      ...testPlan(root, Object.keys(files)),
      only: ['security/config-strength'],
    });
    const findings = result.outcomes[0]?.findings ?? [];
    expect(findings.map((f) => [f.rule, f.location?.file, f.key])).toEqual([
      ['config/weaker', '.gitleaks.project.toml', '.gitleaks.project.toml useDefault'],
      ['config/weaker', '.gitleaks.project.toml', '.gitleaks.project.toml global allowlist'],
      ['config/weaker', 'apps/x/osv-scanner.toml', 'apps/x/osv-scanner.toml osv-scanner ignores'],
      ['config/weaker', 'apps/x/.semgrepignore', 'apps/x/.semgrepignore semgrep ignores'],
    ]);
  });
});

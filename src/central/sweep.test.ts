import { describe, expect, it } from 'vitest';
import {
  alertOf,
  compareVersions,
  groupAlerts,
  isRuntimeFile,
  readSecurityLine,
  type RuntimeAlert,
  securityIssue,
  securityLine,
  unfiled,
} from './sweep.js';
import type { Reported } from '../core/finding.js';
import { judgeReadiness } from '../jobs/readiness.js';

function finding(extra: Partial<Reported>): Reported {
  return {
    rule: 'runtime/security',
    message: 'php 8.4.26 has a security release: 8.4.27 (cycle 8.4)',
    key: 'php 8.4.26',
    check: 'runtime/versions',
    fingerprint: 'f',
    policy: 'always',
    location: { file: 'Dockerfile', line: 1 },
    ...extra,
  };
}

describe('isRuntimeFile', () => {
  it("reads every file the gate's runtime check reads, and the root talos.yml", () => {
    const yes = [
      'Dockerfile',
      'apps/web/Dockerfile',
      'Dockerfile.prod',
      'docker/api.Dockerfile',
      'Containerfile',
      'apps/api/Containerfile.dev',
      '.nvmrc',
      'apps/web/.node-version',
      '.python-version',
      'rust-toolchain.toml',
      'rust-toolchain',
      'go.mod',
      'composer.json',
      'tools.lock',
      'talos.yml',
    ];
    const no = [
      'package.json',
      'docker/readme.md',
      'my-Dockerfile',
      'go.sum',
      'compose.yaml',
      'Dockerfile.dockerignore',
      'vendor/tools.lock',
      'apps/web/talos.yml',
    ];
    expect(yes.filter((p) => !isRuntimeFile(p))).toEqual([]);
    expect(no.filter((p) => isRuntimeFile(p))).toEqual([]);
  });
});

describe('alertOf', () => {
  it('reads the runtime and version from the key and the fix from the message', () => {
    expect(alertOf(finding({}))).toEqual({
      runtime: 'php',
      version: '8.4.26',
      fixed: '8.4.27',
      file: 'Dockerfile',
    });
  });

  it('prefers a fixed version the key names, and picks the newest one a message names', () => {
    expect(alertOf(finding({ key: 'node 22.1.0 22.4.1', message: 'x' }))?.fixed).toBe('22.4.1');
    const message = 'node 22.1.0: 22.3.0 and 22.12.0 are security releases (22.x, 24.1)';
    expect(alertOf(finding({ key: 'Node 22.1.0', message }))).toEqual({
      runtime: 'node',
      version: '22.1.0',
      fixed: '22.12.0',
      file: 'Dockerfile',
    });
  });

  it('says unknown when no fix is named, and drops what is not a runtime alert', () => {
    expect(alertOf(finding({ message: 'php 8.4.26 is vulnerable' }))?.fixed).toBe('unknown');
    const { location: _location, ...unlocated } = finding({});
    expect(alertOf(unlocated)?.file).toBeNull();
    expect(alertOf(finding({ rule: 'runtime/eol' }))).toBeUndefined();
    const { key: _key, ...keyless } = finding({});
    expect(alertOf(keyless)).toBeUndefined();
    expect(alertOf(finding({ key: 'php latest' }))).toBeUndefined();
    expect(alertOf(finding({ key: 'p hp 8.4.26' }))).toBeUndefined();
    expect(alertOf(finding({ key: 'php=evil 8.4.26' }))).toBeUndefined();
  });
});

describe('groupAlerts', () => {
  const alert = (extra: Partial<RuntimeAlert>): RuntimeAlert => ({
    runtime: 'php',
    version: '8.4.26',
    fixed: '8.4.27',
    file: 'Dockerfile',
    ...extra,
  });

  it('groups by runtime and version, listing each file once and the newest fix', () => {
    const groups = groupAlerts([
      alert({}),
      alert({ file: 'api/Dockerfile', fixed: '8.4.28' }),
      alert({ file: 'Dockerfile', fixed: 'unknown' }),
      alert({ runtime: 'node', version: '22.1.0', fixed: 'unknown', file: null }),
      alert({ version: '8.3.1', fixed: '8.3.36', file: 'legacy/Dockerfile' }),
    ]);
    expect(groups).toEqual([
      { runtime: 'node', version: '22.1.0', fixed: 'unknown', files: [] },
      { runtime: 'php', version: '8.3.1', fixed: '8.3.36', files: ['legacy/Dockerfile'] },
      {
        runtime: 'php',
        version: '8.4.26',
        fixed: '8.4.28',
        files: ['Dockerfile', 'api/Dockerfile'],
      },
    ]);
  });

  it('orders versions numerically', () => {
    expect(['8.4.10', '8.4.9', '8.10.0', '8.4'].sort(compareVersions)).toEqual([
      '8.4',
      '8.4.9',
      '8.4.10',
      '8.10.0',
    ]);
  });
});

describe('the security issue', () => {
  const group = { runtime: 'php', version: '8.4.26', fixed: '8.4.27', files: ['Dockerfile'] };

  it('opens with the talos-security/1 line Thea reads', () => {
    const line = securityLine(group);
    expect(line).toBe(
      'talos-security/1 kind=runtime runtime=php version=8.4.26 fixed=8.4.27 priority=p0',
    );
    expect(readSecurityLine(`${line}\n\nmore`)).toEqual({
      kind: 'runtime',
      runtime: 'php',
      version: '8.4.26',
      fixed: '8.4.27',
      priority: 'p0',
    });
    expect(readSecurityLine('talos-debt/1 kind=x')).toBeUndefined();
    expect(readSecurityLine('talos-security/1 Kind=x odd')).toEqual({});
  });

  it('is a p0 bug, ready and in the queue, that passes issue readiness', () => {
    const draft = securityIssue(group);
    expect(draft.body.split('\n')[0]).toBe(securityLine(group));
    expect(draft.labels).toEqual(['bug', 'security', 'priority/p0', 'status/ready', 'ai/eligible']);
    expect(draft.title).toBe('Security release: php 8.4.26 needs 8.4.27');
    const verdict = judgeReadiness({
      body: draft.body,
      labels: draft.labels,
      briefsDir: 'docs/requirements',
      briefs: new Map(),
    });
    expect(verdict).toEqual({ ready: true, problems: [] });
    expect(draft.body).toContain('- `Dockerfile`');
    expect(draft.body).not.toContain('tools.lock');
  });

  it('says where the fix ships when tools.lock pins the runtime, and copes with unknowns', () => {
    const locked = securityIssue({ ...group, fixed: 'unknown', files: ['tools.lock', 'odd name'] });
    expect(locked.title).toBe('Security release: php 8.4.26 needs a patch');
    expect(locked.body).toContain('the owner promotes through the urgent path');
    expect(locked.body).toContain('a file whose name needs quoting');
    expect(securityIssue({ ...group, files: [] }).body).toContain('- the runtime declarations');
  });

  it('files only what no open Talos security issue covers', () => {
    const groups = [group, { ...group, runtime: 'node', version: '22.1.0' }];
    const open = [
      { body: securityLine(group) },
      { body: 'talos-security/1 kind=advisory runtime=node version=22.1.0' },
      { body: 'no marker' },
    ];
    expect(unfiled(groups, open).map((g) => g.runtime)).toEqual(['node']);
  });
});

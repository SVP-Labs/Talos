import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { startDraft } from './draft.js';
import { pnpmWorkspace, RUNNER_PATCH, supplyChain } from './supply.js';
import { pnpmSettings, PNPM_GUARDS } from '../checks/supply/pnpm-settings.js';
import type { Component } from '../core/check.js';

const holds = (text: string | undefined): boolean =>
  PNPM_GUARDS.every((guard) => guard.holds(pnpmSettings(text, undefined)));

describe('pnpmWorkspace', () => {
  it('writes the guards the supply check reads, with why a day and not a week', () => {
    const text = pnpmWorkspace(undefined, { patch: false });
    expect(holds(text)).toBe(true);
    expect(text).toMatch(/^# Supply-chain guards/);
    expect(text).toContain('minimumReleaseAge: 1440\n');
    expect(text).not.toContain('nosemgrep');
    expect(text).not.toContain('patchedDependencies');
  });

  it("merges into the project's file, keeping its keys, comments and longer age", () => {
    const own = [
      'packages:',
      '  - apps/*',
      '',
      '# Fixed releases.',
      'overrides:',
      '  a>b: 1.0.0',
      '',
      'minimumReleaseAge: 10080',
      'trustPolicy: off',
      '',
    ].join('\n');
    const text = pnpmWorkspace(own, { patch: true }) ?? '';
    expect(parse(text)).toEqual({
      packages: ['apps/*'],
      overrides: { 'a>b': '1.0.0' },
      minimumReleaseAge: 10080,
      trustPolicy: 'no-downgrade',
      blockExoticSubdeps: true,
      patchedDependencies: {
        '@stryker-mutator/vitest-runner@10.0.0': `patches/${RUNNER_PATCH}`,
      },
    });
    expect(text).toContain('# Fixed releases.\noverrides:');
    expect(text).toContain("# Stryker's Vitest runner predates Vitest 5");
    expect(pnpmWorkspace(text, { patch: true })).toBeUndefined();
  });

  it("adds the patch beside the project's own, and leaves its own patch of the runner", () => {
    const own = 'minimumReleaseAge: 1440\nblockExoticSubdeps: true\ntrustPolicy: no-downgrade\n';
    const added = pnpmWorkspace(`${own}patchedDependencies:\n  x@1.0.0: patches/x.patch\n`, {
      patch: true,
    });
    expect(parse(added ?? '')).toHaveProperty(['patchedDependencies', 'x@1.0.0']);
    const theirs = `${own}patchedDependencies:\n  '@stryker-mutator/vitest-runner@10.0.0': p.patch\n`;
    expect(pnpmWorkspace(theirs, { patch: true })).toBeUndefined();
    expect(pnpmWorkspace(own, { patch: false })).toBeUndefined();
  });

  it('keeps the comments of a file with nothing else in it', () => {
    expect(pnpmWorkspace('# Ours.\n', { patch: false })).toMatch(/^# Ours\.\n\n# Supply-chain/);
  });

  it("can't merge into a file that isn't a YAML mapping", () => {
    expect(pnpmWorkspace('- a\n', { patch: false })).toBeUndefined();
    expect(pnpmWorkspace('a: [\n', { patch: false })).toBeUndefined();
  });
});

describe('supplyChain', () => {
  const web: Component = { lang: 'ts', root: 'web', os: ['linux'] };
  const pinsRunner = '{"devDependencies":{"@stryker-mutator/vitest-runner":"10.0.0"}}';

  function run(texts: Record<string, string>, components: Component[], exclude: string[] = []) {
    const draft = startDraft(Object.keys(texts), (path) => texts[path]);
    supplyChain(draft, components, exclude, 'the patch\n');
    return { ...draft.done(), read: draft.read };
  }

  it('guards pnpm beside each lockfile, and patches the runner a component pins', () => {
    const out = run(
      {
        'pnpm-lock.yaml': '',
        'web/package.json': pinsRunner,
        'docs/pnpm-lock.yaml': '',
        'vendor/pnpm-lock.yaml': '',
      },
      [web],
      ['vendor'],
    );
    expect(out.write.map((f) => `${f.why} ${f.path}`)).toEqual([
      'supply-chain pnpm-workspace.yaml',
      'patch patches/@stryker-mutator__vitest-runner@10.0.0.patch',
      'supply-chain docs/pnpm-workspace.yaml',
    ]);
    expect(out.read(`patches/${RUNNER_PATCH}`)).toBe('the patch\n');
    expect(out.next).toEqual(['in .: pnpm install --lockfile-only']);
  });

  it('guards where pnpm will put a component without a lockfile, and not npm or Yarn', () => {
    expect(run({ 'web/package.json': '{}' }, [web]).write.map((f) => f.path)).toEqual([
      'web/pnpm-workspace.yaml',
    ]);
    expect(
      run({ 'web/package-lock.json': '', 'web/package.json': pinsRunner }, [web]).write,
    ).toEqual([]);
  });

  it('says so when the workspace file is not YAML it can read', () => {
    const out = run({ 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': 'a: [\n' }, []);
    expect(out.next).toEqual([
      'in .: pnpm-workspace.yaml is not YAML Talos can read; set its guards by hand',
    ]);
  });
});

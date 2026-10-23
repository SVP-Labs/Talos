import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { semgrepCheck, semgrepConfigs } from './semgrep.js';
import { repoFacts } from '../../repo/facts.js';
import { infraContext, ok, recording } from '../infra/test/context.js';

describe("semgrep's Dockerfile rules", () => {
  it('run for a Dockerfile or a Containerfile, by any name Docker or Podman gives one', () => {
    for (const file of ['ops/Containerfile', 'api.Dockerfile', 'Dockerfile.prod', 'dockerfile']) {
      expect(semgrepConfigs(repoFacts([file], []))).toContain('p/dockerfile');
    }
  });

  it('never run for a source file named after one', () => {
    const facts = repoFacts(['src/infra/dockerfile.ts', 'src/infra/dockerfile.test.ts'], []);
    expect(semgrepConfigs(facts)).not.toContain('p/dockerfile');
  });
});

describe('the scan', () => {
  it("leaves out the registry rules that ask for longer waits than SVP-Labs' one day", async () => {
    const { exec, calls } = recording(async ({ args }) => {
      const output = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
      if (output !== undefined) await writeFile(output, '{"results": []}');
      return ok('');
    });
    const ctx = await infraContext({ '.github/dependabot.yml': 'version: 2\n' }, exec);
    expect(await semgrepCheck().run(ctx)).toEqual([]);
    const excluded = (calls[0]?.args ?? []).filter((arg) => arg.startsWith('--exclude-rule='));
    expect(excluded).toEqual([
      '--exclude-rule=package_managers.pnpm.pnpm-missing-minimum-release-age.pnpm-minimum-release-age',
      '--exclude-rule=package_managers.dependabot.dependabot-missing-cooldown.dependabot-missing-cooldown',
    ]);
  });

  it('scans the tracked files the run judges, never what else lies in the checkout', async () => {
    const { exec, calls } = recording(async ({ args }) => {
      const output = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
      if (output !== undefined) await writeFile(output, '{"results": []}');
      return ok('');
    });
    const ctx = await infraContext({ 'src/a.ts': 'x\n', 'README.md': '# A\n' }, exec);
    await semgrepCheck().run(ctx);
    const args = calls[0]?.args ?? [];
    expect(args).not.toContain('.');
    expect(args.slice(-2).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'README.md',
      'src/a.ts',
    ]);
  });

  it('splits a long list of files over several scans and keeps every finding', async () => {
    const { exec, calls } = recording(async ({ args }) => {
      const output = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
      const target = args.at(-1) ?? '';
      const found = {
        check_id: 'r',
        path: target,
        start: { line: 1 },
        end: { line: 1 },
        extra: {},
      };
      if (output !== undefined) await writeFile(output, JSON.stringify({ results: [found] }));
      return ok('');
    });
    const files = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`src/${'d'.repeat(200)}/file-${i}.ts`, 'x\n']),
    );
    const ctx = await infraContext(files, exec);
    const findings = await semgrepCheck().run(ctx);
    expect(calls.length).toBeGreaterThan(1);
    expect(findings).toHaveLength(calls.length);
    const scanned = calls.flatMap((call) => call.args.filter((arg) => arg.startsWith('src/')));
    expect(new Set(scanned).size).toBe(600);
  });
});

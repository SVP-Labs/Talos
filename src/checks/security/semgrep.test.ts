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
});

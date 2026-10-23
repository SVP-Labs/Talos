import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../context.js';
import { parseConfig } from '../../config/load.js';
import type { TalosConfig } from '../../config/schema.js';
import { silentLogger } from '../../core/log.js';
import { identities } from '../../github/identities.js';
import type { FakeGitHub } from '../../ticket/test/fake-github.js';

export const TEST_CONFIG = 'name: Test\nprefix: T\n';

/** A job context over a fake GitHub, acting as the reviewer, with the workflow's token too. */
export async function testContext(
  fake: FakeGitHub,
  overrides: Partial<JobContext> & { readonly config?: TalosConfig } = {},
): Promise<JobContext> {
  const workdir = await mkdtemp(join(tmpdir(), 'talos-job-test-'));
  const config = overrides.config ?? parseConfig(TEST_CONFIG);
  const { config: _ignored, ...rest } = overrides;
  return {
    event: 'schedule',
    payload: {},
    repo: 'o/r',
    phase: 'act',
    gh: fake.client('talos-reviewer[bot]'),
    actions: fake.client('github-actions[bot]'),
    who: identities({}),
    env: {},
    now: new Date('2026-10-26T03:17:00Z'),
    log: silentLogger,
    workdir,
    config: () => Promise.resolve(config),
    ...rest,
  };
}

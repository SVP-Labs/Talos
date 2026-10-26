import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../config/load.js';
import type { TalosConfig } from '../../config/schema.js';
import { silentLogger } from '../../core/log.js';
import type { GitHub } from '../../github/api.js';
import { identities } from '../../github/identities.js';
import type { FakeGitHub } from '../../ticket/test/fake-github.js';
import type { JobContext } from '../context.js';

const TEST_CONFIG = 'name: Test\nprefix: T\n';

type Overrides = Omit<Partial<JobContext>, 'gh' | 'actions' | 'config'> & {
  /** `undefined` leaves the token out. */
  readonly gh?: GitHub | undefined;
  readonly actions?: GitHub | undefined;
  readonly config?: TalosConfig;
};

/** A job context over a fake GitHub, acting as the reviewer, with the workflow's token too. */
export async function testContext(
  fake: FakeGitHub,
  overrides: Overrides = {},
): Promise<JobContext> {
  const workdir = await mkdtemp(join(tmpdir(), 'talos-job-test-'));
  const config = overrides.config ?? parseConfig(TEST_CONFIG);
  const { gh, actions, config: _config, ...rest } = overrides;
  const reviewer = 'gh' in overrides ? gh : fake.client('talos-reviewer[bot]');
  const workflow = 'actions' in overrides ? actions : fake.client('github-actions[bot]');
  return {
    event: 'schedule',
    payload: {},
    repo: 'o/r',
    phase: 'act',
    who: identities({}),
    env: {},
    now: new Date('2026-10-26T03:17:00Z'),
    log: silentLogger,
    workdir,
    config: () => Promise.resolve(config),
    ...rest,
    ...(reviewer === undefined ? {} : { gh: reviewer }),
    ...(workflow === undefined ? {} : { actions: workflow }),
  };
}

import { type Command, parse, UsageError } from './io.js';
import { exec } from '../exec/exec.js';
import { github, tokenFromEnvironment } from '../github/api.js';
import { identities } from '../github/identities.js';
import { currentRepository, isRepoName } from '../github/remote.js';
import { orgStatus, statusContext, statusOf } from '../status/collect.js';
import { statusText } from '../status/text.js';
import { lookupMode } from '../version/pin.js';

/**
 * `talos status [--repo owner/name]... [--org] [--json]`: each repository's state, read from
 * GitHub. `--json` prints an array of `talos.status/1` objects, one per repository, on one line.
 * Exits 1 when a repository couldn't be read; its object then carries `error`.
 */
export const status: Command = async (argv, io) => {
  const { values } = parse(argv, {
    repo: { type: 'string', multiple: true },
    org: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  const named = values.repo ?? [];
  if (values.org && named.length > 0) throw new UsageError('--org and --repo exclude each other');
  const invalid = named.find((repo) => !isRepoName(repo));
  if (invalid !== undefined) throw new UsageError(`--repo takes owner/name, not "${invalid}"`);
  let repos = named;
  if (!values.org && repos.length === 0) {
    const here = await currentRepository(io.env, io.cwd, exec);
    if (here === undefined) {
      throw new UsageError('no GitHub repository here: pass --repo owner/name or --org');
    }
    repos = [here];
  }
  const ctx = statusContext(
    github(await tokenFromEnvironment(io.env)),
    identities(io.env),
    lookupMode(io.env),
  );
  const statuses = values.org ? await orgStatus(ctx) : await statusOf(ctx, repos);
  io.out(values.json ? `${JSON.stringify(statuses)}\n` : statusText(statuses));
  return statuses.some((s) => 'error' in s) ? 1 : 0;
};

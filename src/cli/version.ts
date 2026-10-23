import { type Command, parse, UsageError } from './io.js';
import { exec } from '../exec/exec.js';
import { currentRepository, isRepoName } from '../github/remote.js';
import { enforcedRelease } from '../version/enforced.js';
import { ownVersion } from '../version/self.js';

/**
 * `talos version`: this copy's version. `--enforced [--repo owner/name] --json` instead prints the
 * release the repository's rulesets pin, `{ version, sha, from }`, which Thea's hub hands to tasks.
 */
export const version: Command = async (argv, io) => {
  const { values } = parse(argv, {
    enforced: { type: 'boolean', default: false },
    repo: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  if (!values.enforced) {
    io.out(`${ownVersion()}\n`);
    return 0;
  }
  if (values.repo !== undefined && !isRepoName(values.repo)) {
    throw new UsageError(`--repo takes owner/name, not "${values.repo}"`);
  }
  const repo = values.repo ?? (await currentRepository(io.env, io.cwd, exec));
  const release = await enforcedRelease({ env: io.env, repo });
  const answer = { schema: 'talos.version/1', repo: repo ?? null, ...release };
  io.out(values.json ? `${JSON.stringify(answer)}\n` : `${release.version} (${release.sha})\n`);
  return 0;
};

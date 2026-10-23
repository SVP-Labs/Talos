import { type Command, parse, required, UsageError } from './io.js';
import { exec } from '../exec/exec.js';
import { github, tokenFromEnvironment } from '../github/api.js';
import { downloader } from '../github/artifacts.js';
import { identities } from '../github/identities.js';
import { isRepoName } from '../github/remote.js';
import { prFindings } from '../status/findings.js';

/**
 * `talos findings --repo owner/name --pr <n> --json`: the latest gate verdict for a PR's head, as
 * the gate left it (`talos.verdict/1`), so an event can carry it without anyone reading logs.
 */
export const findings: Command = async (argv, io) => {
  const { values } = parse(argv, {
    repo: { type: 'string' },
    pr: { type: 'string' },
    json: { type: 'boolean', default: true },
  });
  const repo = required(values.repo, 'repo');
  if (!isRepoName(repo)) throw new UsageError(`--repo takes owner/name, not "${repo}"`);
  const pr = Number(required(values.pr, 'pr'));
  if (!Number.isInteger(pr) || pr < 1) throw new UsageError('--pr takes a pull request number');
  const token = await tokenFromEnvironment(io.env);
  const gh = github(token);
  const deps = { gh, download: downloader(token), exec, talosRepo: identities(io.env).talosRepo };
  const verdict = await prFindings(deps, repo, pr);
  io.out(`${JSON.stringify(verdict)}\n`);
  return verdict.status === 'red' ? 1 : 0;
};

import { describe, expect, it } from 'vitest';
import { type GitHub, GitHubError } from './api.js';
import { ownerIdentities } from './org-variables.js';

/** A client that answers each variable's GET from `variables`, or with `status` for the rest. */
function variablesApi(variables: Record<string, string>, status = 404) {
  const asked: string[] = [];
  const gh: GitHub = {
    request: <T>(method: string, path: string) => {
      asked.push(`${method} ${path}`);
      const name = /^orgs\/SVP-Labs\/actions\/variables\/(\w+)$/.exec(path)?.[1] ?? '';
      const value = variables[name];
      return value === undefined
        ? Promise.reject(new GitHubError(`${method} ${path}: ${String(status)}`, status))
        : Promise.resolve({ name, value } as T);
    },
    paginate: () => Promise.reject(new Error('no lists here')),
    graphql: () => Promise.reject(new Error('no GraphQL here')),
  };
  return { gh, asked };
}

describe('ownerIdentities', () => {
  it("reads the organisation's variables the environment leaves unset, the environment winning", async () => {
    const { gh, asked } = variablesApi({ TALOS_THEA_APP: 'thea-org', TALOS_OWNER: 'org-owner' });
    const warned: string[] = [];
    const who = await ownerIdentities(gh, { TALOS_OWNER: 'me', TALOS_RELEASE_APP: '' }, (line) =>
      warned.push(line),
    );
    expect(who).toMatchObject({
      owner: 'me',
      thea: 'thea-org[bot]',
      reviewer: 'talos-reviewer[bot]',
      release: 'talos-release[bot]',
    });
    expect(asked).toEqual([
      'GET orgs/SVP-Labs/actions/variables/TALOS_THEA_APP',
      'GET orgs/SVP-Labs/actions/variables/TALOS_REVIEWER_APP',
      'GET orgs/SVP-Labs/actions/variables/TALOS_RELEASE_APP',
    ]);
    expect(warned).toEqual([]);
  });

  it('keeps the default where the token may not read a variable, and says so', async () => {
    const { gh } = variablesApi({}, 403);
    const warned: string[] = [];
    const who = await ownerIdentities(gh, { TALOS_OWNER: 'me' }, (line) => warned.push(line));
    expect(who.thea).toBe('thea-svp[bot]');
    expect(warned).toHaveLength(3);
    expect(warned[0]).toBe(
      "could not read SVP-Labs's variable TALOS_THEA_APP (403), so its default stands in: " +
        'set TALOS_THEA_APP to choose, or run `gh auth refresh -s admin:org`',
    );
  });
});

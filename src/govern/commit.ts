import { z } from 'zod';
import type { GitHub } from '../github/api.js';

export type FileChanges = {
  readonly branch: string;
  /** The branch head the changes were planned against; GitHub refuses the commit if it moved. */
  readonly expectedHead: string;
  /** The first line is the commit's subject. */
  readonly message: string;
  readonly additions: readonly { readonly path: string; readonly contents: string }[];
  readonly deletions: readonly string[];
};

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

const resultSchema = z.object({
  createCommitOnBranch: z.object({ commit: z.object({ oid: z.string() }) }),
});

/**
 * One commit straight onto a branch, through GraphQL's `createCommitOnBranch`: GitHub signs it
 * and records the token's user as author and committer, so a commit `talos govern` makes as the
 * owner is the owner's, verified. Writing a workflow file this way needs the `workflow` scope.
 */
export async function commitFiles(gh: GitHub, repo: string, changes: FileChanges): Promise<string> {
  const [headline = '', ...rest] = changes.message.split('\n');
  const body = rest.join('\n').trim();
  const input = {
    branch: { repositoryNameWithOwner: repo, branchName: changes.branch },
    message: body === '' ? { headline } : { headline, body },
    expectedHeadOid: changes.expectedHead,
    fileChanges: {
      additions: changes.additions.map((file) => ({
        path: file.path,
        contents: Buffer.from(file.contents, 'utf8').toString('base64'),
      })),
      deletions: changes.deletions.map((path) => ({ path })),
    },
  };
  const data = await gh.graphql<unknown>(MUTATION, { input });
  return resultSchema.parse(data).createCommitOnBranch.commit.oid;
}

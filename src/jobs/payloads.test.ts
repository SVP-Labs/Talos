import { describe, expect, it } from 'vitest';
import { admission } from './payloads.js';
import { identities } from '../github/identities.js';

const who = identities({});

function comment(login: string, association: string): unknown {
  return { comment: { user: { login }, author_association: association }, sender: { login } };
}

function review(login: string, association: string): unknown {
  return { review: { user: { login }, author_association: association, state: 'commented' } };
}

describe('admission', () => {
  it('admits comments and reviews from the owner, members and collaborators', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(admission('issue_comment', comment('x', association), who)).toEqual({ admit: true });
      expect(admission('pull_request_review', review('x', association), who)).toEqual({ admit: true });
    }
  });

  it("admits Thea's App, whose approval reviews carry the owner's okay", () => {
    expect(admission('pull_request_review', review('thea-svp[bot]', 'NONE'), who)).toEqual({
      admit: true,
    });
  });

  it('turns strangers away', () => {
    for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR']) {
      expect(admission('issue_comment', comment('mallory', association), who)).toEqual({
        admit: false,
        reason: 'author not trusted',
      });
      expect(admission('pull_request_review', review('mallory', association), who).admit).toBe(false);
    }
  });

  it("turns away the reviewer's own review, which would start it again", () => {
    expect(admission('pull_request_review', review('talos-reviewer[bot]', 'NONE'), who)).toEqual({
      admit: false,
      reason: "the reviewer's own event",
    });
  });

  it('turns away a payload it cannot read', () => {
    expect(admission('issue_comment', { comment: 'x' }, who)).toEqual({
      admit: false,
      reason: 'unreadable payload',
    });
    expect(admission('pull_request_review', null, who).admit).toBe(false);
  });

  it('admits every other event; their jobs judge them', () => {
    for (const event of ['issues', 'pull_request_target', 'merge_group', 'schedule', 'workflow_dispatch']) {
      expect(admission(event, {}, who)).toEqual({ admit: true });
    }
  });
});

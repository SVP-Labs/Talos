import { describe, expect, it } from 'vitest';
import { carriesApproval, isTalos, isTrusted } from './trust.js';
import { identities } from '../github/identities.js';

const who = identities({});

describe('isTrusted', () => {
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('trusts %s', (association) => {
    expect(isTrusted({ login: 'someone', association }, who)).toBe(true);
  });

  it.each(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE'])(
    'does not trust %s',
    (association) => {
      expect(isTrusted({ login: 'stranger', association }, who)).toBe(false);
    },
  );

  it("trusts the owner, Thea's App and Talos's Apps by login, whatever the association", () => {
    for (const login of ['SvenPGH', 'thea-svp[bot]', 'talos-reviewer[bot]', 'talos-release[bot]']) {
      expect(isTrusted({ login, association: 'NONE' }, who)).toBe(true);
    }
  });

  it('follows the identities the environment names', () => {
    const custom = identities({ TALOS_THEA_APP: 'thea-test', TALOS_OWNER: 'alice' });
    expect(isTrusted({ login: 'thea-test[bot]', association: 'NONE' }, custom)).toBe(true);
    expect(isTrusted({ login: 'thea-svp[bot]', association: 'NONE' }, custom)).toBe(false);
    expect(isTrusted({ login: 'alice', association: undefined }, custom)).toBe(true);
  });

  it('compares logins without case, as GitHub does', () => {
    const custom = identities({ TALOS_OWNER: 'Alice', TALOS_REVIEWER_APP: 'Talos-Reviewer' });
    expect(isTrusted({ login: 'alice', association: 'NONE' }, custom)).toBe(true);
    expect(isTalos('talos-reviewer[bot]', custom)).toBe(true);
    expect(isTalos('TALOS-RELEASE[bot]', who)).toBe(true);
  });

  it('does not trust an author it knows nothing about', () => {
    expect(isTrusted({ login: undefined, association: undefined }, who)).toBe(false);
  });
});

describe('isTalos', () => {
  it("is true for Talos's own Apps only", () => {
    expect(isTalos('talos-reviewer[bot]', who)).toBe(true);
    expect(isTalos('talos-release[bot]', who)).toBe(true);
    expect(isTalos('thea-svp[bot]', who)).toBe(false);
    expect(isTalos(undefined, who)).toBe(false);
  });
});

describe('carriesApproval', () => {
  it('finds the approval marker in any case', () => {
    expect(carriesApproval('ok talos-approve card-1 abc')).toBe(true);
    expect(carriesApproval('TALOS-APPROVE')).toBe(true);
    expect(carriesApproval('talos approve')).toBe(false);
  });
});

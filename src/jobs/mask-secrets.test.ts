import { describe, expect, it } from 'vitest';
import { maskSecrets } from './mask-secrets.js';

describe('maskSecrets', () => {
  const join2 = (...parts: string[]): string => parts.join('');

  it.each([
    ['a GitHub token', `use ${join2('gh', 's_', 'k'.repeat(36))} now`, 'use *** now'],
    ['an AWS key id', `id ${join2('AK', 'IA', 'ABCDEFGH12345678')}.`, 'id ***.'],
    ['a Slack token', `hook ${join2('xox', 'b-', '1234567890-abc')}`, 'hook ***'],
    ['an npm token', `auth ${join2('npm', '_', 'a'.repeat(36))}`, 'auth ***'],
    ['a GitLab token', `push ${join2('gl', 'pat', '-', 'x1Y2'.repeat(5))} ok`, 'push *** ok'],
    [
      'a JWT',
      `jwt ${join2('eyJ', 'h'.repeat(10), '.', 'p'.repeat(10), '.', 's'.repeat(10))}`,
      'jwt ***',
    ],
    [
      'URL credentials',
      'git clone https://me:hunter2pass@example.com/r',
      'git clone https://***@example.com/r',
    ],
    ['a bearer header', `Authorization: Bearer ${'t'.repeat(30)}`, 'Authorization: Bearer ***'],
    ['a named value', `DB_PASSWORD=${'p'.repeat(12)} next`, 'DB_PASSWORD=*** next'],
    ['a quoted named value', `"api_key": "${'k'.repeat(20)}"`, '"api_key": "***"'],
    [
      'a private key',
      join2('-----BEGIN RSA ', 'PRIVATE KEY-----\nbody\n-----END RSA ', 'PRIVATE KEY----- after'),
      '*** after',
    ],
  ])('masks %s', (_, text, masked) => {
    expect(maskSecrets(text)).toBe(masked);
  });

  it('leaves ordinary tool output alone', () => {
    const text = 'Ran 2496 tests in 3 minutes; 41784 mutants, tokens: 55 (src/a.ts:12)';
    expect(maskSecrets(text)).toBe(text);
  });
});

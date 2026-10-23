import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inside, packAssessor } from './runtime-port.js';
import { APPLIES, type Check, EngineError, skip } from '../core/check.js';
import type { Pack } from '../core/pack.js';

const FROM = /^FROM php:(\d+\.\d+\.\d+)/m;

/** Stands in for the runtime pack: a PHP image older than 8.4.27 is a security release behind. */
const php: Check = {
  id: 'runtime/fake-php',
  tier: 'head',
  scope: 'repo',
  title: 'PHP images',
  applies: (ctx) => (ctx.facts.has('**/Dockerfile') ? APPLIES : skip('no Dockerfile')),
  run: async (ctx) => {
    const findings = [];
    for (const file of ctx.facts.matching('**/Dockerfile')) {
      const version = FROM.exec(await readFile(join(ctx.root, file), 'utf8'))?.[1];
      if (version === undefined) throw new EngineError('no FROM line');
      if (version !== '8.4.27') {
        findings.push({
          rule: 'runtime/security',
          message: `php ${version}: 8.4.27 is a security release of its cycle`,
          key: `php ${version}`,
          policy: 'always' as const,
          location: { file, line: 1 },
        });
      }
    }
    return findings;
  },
};

const pack: Pack = { name: 'fake-runtime', checks: [php] };

describe('packAssessor', () => {
  it("runs the pack's checks over the files and returns the security alerts", async () => {
    const files = new Map([
      ['Dockerfile', 'FROM php:8.4.26-fpm\n'],
      ['api/Dockerfile', 'FROM php:8.4.27-cli\n'],
      ['talos.yml', 'name: App\nprefix: AP\nexclude: [vendor]\n'],
      ['vendor/x/Dockerfile', 'FROM php:8.1.0\n'],
      ['../escape/Dockerfile', 'FROM php:1.0.0\n'],
    ]);
    expect(await packAssessor(pack)(files)).toEqual({
      alerts: [{ runtime: 'php', version: '8.4.26', fixed: '8.4.27', file: 'Dockerfile' }],
      errors: 0,
    });
  });

  it('counts an engine error, and falls back to a plain config for an invalid talos.yml', async () => {
    const files = new Map([
      ['Dockerfile', 'FROM scratch\n'],
      ['talos.yml', 'name: [\n'],
    ]);
    expect(await packAssessor(pack)(files)).toEqual({ alerts: [], errors: 1 });
  });

  it('finds nothing in a repository without declarations', async () => {
    expect(await packAssessor(pack)(new Map())).toEqual({ alerts: [], errors: 0 });
  });

  it('wraps the runtime pack by default', () => {
    expect(typeof packAssessor()).toBe('function');
  });
});

describe('inside', () => {
  it('keeps paths under the root and refuses the rest', () => {
    expect(inside('/r', 'a/b')).toBe(join('/r', 'a/b'));
    expect(inside('/r', '../x')).toBeUndefined();
    expect(inside('/r', 'a/../../x')).toBeUndefined();
    expect(inside('/r', '/etc/passwd')).toBeUndefined();
    expect(inside('/r', '.')).toBeUndefined();
  });
});

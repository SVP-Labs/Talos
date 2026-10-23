import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from './load.js';

const HEAD = parseConfig('name: Head\nprefix: H\n');

async function checkout(talosYml?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talos-load-test-'));
  if (talosYml !== undefined) await writeFile(join(root, 'talos.yml'), talosYml);
  return root;
}

describe('loadConfig', () => {
  it("reads the checkout's own talos.yml, even when a fallback is given", async () => {
    const config = await loadConfig(await checkout('name: Own\nprefix: O\n'), HEAD);
    expect(config.name).toBe('Own');
  });

  it('takes the fallback only for a checkout without talos.yml', async () => {
    expect(await loadConfig(await checkout(), HEAD)).toBe(HEAD);
    await expect(loadConfig(await checkout())).rejects.toThrow(ConfigError);
  });

  it('never lets the fallback hide a talos.yml it cannot read', async () => {
    await expect(loadConfig(await checkout('name: [\n'), HEAD)).rejects.toThrow(ConfigError);
  });
});

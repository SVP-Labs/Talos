import { describe, expect, it } from 'vitest';
import { configsPack } from './index.js';
import { RENDERING_PACKS } from './packs.js';
import { PACKS } from '../core/registry.js';

describe('RENDERING_PACKS', () => {
  it("is the registry's list less the configs pack, which renders nothing", () => {
    expect(RENDERING_PACKS).toStrictEqual(PACKS.filter((pack) => pack !== configsPack));
    expect(configsPack.generated ?? []).toEqual([]);
  });
});

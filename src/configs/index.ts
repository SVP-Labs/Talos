import { driftCheck } from './drift.js';
import { RENDERING_PACKS } from './packs.js';
import type { Pack } from '../core/pack.js';

/** Generated-file drift: each base config committed as this Talos renders it. */
export const configsPack: Pack = {
  name: 'configs',
  checks: [driftCheck(RENDERING_PACKS)],
};

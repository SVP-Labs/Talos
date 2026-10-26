import { runtimesCheck } from './check.js';
import type { Pack } from '../../core/pack.js';

/** Runtimes against their vendors' feeds; `README.md` beside this file describes the check. */
export const runtimePack: Pack = {
  name: 'runtime',
  checks: [runtimesCheck()],
};

import { customCommitCheck, customHeadCheck } from './custom.js';
import { duplicationCheck } from './duplication.js';
import { jscpdBase } from './jscpd-config.js';
import { suppressionsCheck } from './suppressions.js';
import type { Pack } from '../../core/pack.js';

/**
 * The checks every repository gets whatever its languages: no suppressions per commit, the
 * project's own checks from `talos.yml`, and no repeated code across every language at the head.
 */
export const commonPack: Pack = {
  name: 'common',
  checks: [suppressionsCheck, customCommitCheck, duplicationCheck, customHeadCheck],
  generated: [jscpdBase],
};

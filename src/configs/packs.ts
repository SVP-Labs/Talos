import { commonPack } from '../checks/common/index.js';
import { docsPack } from '../checks/docs/index.js';
import { infraPack } from '../checks/infra/index.js';
import { runtimePack } from '../checks/runtime/index.js';
import { securityPack } from '../checks/security/index.js';
import { supplyPack } from '../checks/supply/index.js';
import type { Pack } from '../core/pack.js';
import { luaPack } from '../langs/lua/index.js';
import { phpPack } from '../langs/php/index.js';
import { pyPack } from '../langs/py/index.js';
import { rustPack } from '../langs/rust/index.js';
import { tsPack } from '../langs/ts/index.js';

/**
 * The packs whose generated files the drift check compares: the registry's, less the configs
 * pack, which renders none. The registry lists the configs pack, so the drift check can't read
 * the registry without an import cycle; a test keeps the two lists the same.
 */
export const RENDERING_PACKS: readonly Pack[] = [
  tsPack,
  pyPack,
  phpPack,
  luaPack,
  rustPack,
  commonPack,
  securityPack,
  supplyPack,
  runtimePack,
  docsPack,
  infraPack,
];

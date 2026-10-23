import type { Pack } from './pack.js';
import { commonPack } from '../checks/common/index.js';
import { docsPack } from '../checks/docs/index.js';
import { infraPack } from '../checks/infra/index.js';
import { runtimePack } from '../checks/runtime/index.js';
import { securityPack } from '../checks/security/index.js';
import { supplyPack } from '../checks/supply/index.js';
import { configsPack } from '../configs/index.js';
import { luaPack } from '../langs/lua/index.js';
import { phpPack } from '../langs/php/index.js';
import { pyPack } from '../langs/py/index.js';
import { rustPack } from '../langs/rust/index.js';
import { tsPack } from '../langs/ts/index.js';

/** Every pack of checks Talos ships, in the order their checks run. */
export const PACKS: readonly Pack[] = [
  configsPack,
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

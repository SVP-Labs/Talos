import { LIVE, type SupplyDeps } from './deps.js';
import { exoticCheck } from './exotic.js';
import { expiredCheck } from './expired.js';
import { provenanceCheck } from './provenance.js';
import { releaseAgeCheck } from './release-age.js';
import { settingsCheck } from './settings.js';
import type { Check } from '../../core/check.js';
import type { Pack } from '../../core/pack.js';

/** The supply-chain checks, reaching the registries and the clock through `deps`. */
export function supplyChecks(deps: SupplyDeps): Check[] {
  return [
    releaseAgeCheck(deps),
    exoticCheck(),
    provenanceCheck(deps),
    settingsCheck(),
    expiredCheck(deps),
  ];
}

export const supplyPack: Pack = {
  name: 'supply',
  checks: supplyChecks(LIVE),
};

import { type Fetcher, httpFetcher } from './fetcher.js';
import { lockfiles } from './lockfiles/index.js';
import { APPLIES, type ApplyContext, type Applicability, skip } from '../../core/check.js';

/** What the supply checks reach outside the repository: the registries, and the clock. */
export type SupplyDeps = { readonly fetcher: Fetcher; readonly now: () => Date };

export const LIVE: SupplyDeps = { fetcher: httpFetcher, now: () => new Date() };

export function hasLockfile(ctx: ApplyContext): Applicability {
  return lockfiles(ctx.facts).length > 0 ? APPLIES : skip('the repository has no lockfile');
}

/** One spending, in the currency's minor unit. */
export type Entry = { readonly when: string; readonly amount: number };

/** The total of the entries, which never rounds because amounts are whole numbers. */
export function total(entries: readonly Entry[]): number {
  return entries.reduce((sum, entry) => sum + entry.amount, 0);
}

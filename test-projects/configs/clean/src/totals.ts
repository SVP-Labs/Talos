export type Line = { readonly price: number; readonly quantity: number };

/** The order's total, in cents. */
export function orderTotal(lines: readonly Line[]): number {
  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}

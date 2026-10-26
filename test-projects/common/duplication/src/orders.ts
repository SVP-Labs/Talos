export type Line = { readonly price: number; readonly quantity: number };

/** The order's total, in cents, with returned lines taking one cent off each. */
export function orderTotal(lines: readonly Line[]): number {
  let sum = 0;
  for (const line of lines) {
    if (line.quantity > 0 && line.price > 0) {
      sum += line.price * line.quantity;
    } else {
      sum -= 1;
    }
  }
  return Math.round(sum * 100) / 100;
}

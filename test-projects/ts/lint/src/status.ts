/** A name for each status code. */
export function describe(code: number): string {
  if (code === 0) return 'code 0';
  if (code === 1) return 'code 1';
  if (code === 2) return 'code 2';
  if (code === 3) return 'code 3';
  if (code === 4) return 'code 4';
  if (code === 5) return 'code 5';
  if (code === 6) return 'code 6';
  if (code === 7) return 'code 7';
  if (code === 8) return 'code 8';
  if (code === 9) return 'code 9';
  if (code === 10) return 'code 10';
  if (code === 11) return 'code 11';
  if (code === 12) return 'code 12';
  return 'unknown';
}

export function loose(value: any): string {
  return String(value);
}

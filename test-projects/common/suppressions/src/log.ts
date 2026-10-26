export function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

export function length(value: unknown): number {
  // @ts-expect-error: callers pass strings
  return value.length;
}

/* istanbul ignore next */
export function never(): never {
  throw new Error('unreachable');
}

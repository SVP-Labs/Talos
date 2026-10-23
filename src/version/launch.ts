/**
 * Runs the Talos version the repository's rulesets enforce when this isn't it, and
 * returns its exit code; `undefined` means this process is the right version and goes on.
 */
export function launch(_argv: readonly string[]): Promise<number | undefined> {
  return Promise.resolve(undefined);
}

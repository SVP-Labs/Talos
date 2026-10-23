/**
 * What a compact verdict (`talos.verdict/1`) holds at most, as
 * `docs/contracts/verdict.schema.json` publishes it: lists by their items, text by its characters,
 * and the whole by the bytes of its compact JSON, since escaped text can take six bytes a
 * character. The gate writes within these and `talos findings` passes nothing past them, so an
 * event or a hub reading the verdict whole can hold it.
 */
export const VERDICT_CAPS = {
  /** Blocking findings and flaky tests listed. */
  listed: 20,
  faults: 5,
  /** Rules `counts.byRule` counts: those with the most blocking findings. */
  rules: 40,
  message: 200,
  reason: 300,
  /** A rule id, `<tool>/<rule>`, also as a key of `counts.byRule`. */
  rule: 100,
  /** A finding's or a flaky test's file. */
  path: 300,
  /** A flaky test's id. */
  test: 300,
  check: 100,
  talos: 50,
  bytes: 48 * 1024,
} as const;

/** The bytes a value takes as compact JSON, as `talos findings` prints it. */
export function printedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

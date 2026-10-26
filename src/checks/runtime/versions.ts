/** A release number: dotted digits, nothing else. */
const RELEASE = /^\d+(?:\.\d+)*$/;

/** Whether the text is a plain release number, such as `8.4.26` or `22`. */
export function isRelease(text: string): boolean {
  return RELEASE.test(text);
}

/** One exact release: major, minor and patch, with no pre-release suffix. */
export function isExactRelease(text: string): boolean {
  return isRelease(text) && text.split('.').length === 3;
}

function numbers(version: string): number[] {
  return version.split('.').map(Number);
}

/** Numeric order of dotted versions; a shorter one sorts first on a tie. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [numbers(a), numbers(b)];
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) {
    const diff = (x[index] ?? -1) - (y[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The newest of the versions, or `undefined` for none. */
export function newest(versions: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const version of versions) {
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** Whether `version` belongs to the release cycle `cycle`: `8.4.26` to `8.4`, `22.1.0` to `22`. */
export function inCycle(version: string, cycle: string): boolean {
  return version === cycle || version.startsWith(`${cycle}.`);
}

/** The most specific of the cycles a version belongs to. */
export function cycleOf(version: string, cycles: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const cycle of cycles) {
    if (inCycle(version, cycle) && (found === undefined || cycle.length > found.length)) {
      found = cycle;
    }
  }
  return found;
}

/** The leading release number of a text (`8.4.26` of `8.4.26RC1`), or `undefined`. */
export function leadingRelease(text: string): string | undefined {
  return /^\d+(?:\.\d+)*/.exec(text)?.[0];
}

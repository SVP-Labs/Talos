/**
 * Which paths hold tests, in every language Talos governs, and which tests belong to a file:
 * a debt issue's Affected areas cover the files it names plus their tests.
 */

const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|specs?)\//;
const TEST_FILE = new RegExp(
  [
    String.raw`\.(?:test|spec)\.[cm]?[jt]sx?$`,
    String.raw`(?:^|/)test_[^/]+\.py$`,
    String.raw`_test\.(?:py|go|rb|lua)$`,
    String.raw`(?:^|/)conftest\.py$`,
    String.raw`Tests?\.(?:php|java|kt)$`,
    String.raw`_spec\.(?:lua|rb)$`,
  ].join('|'),
);

export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A file name without its last extension: `util.test.ts` → `util.test`. */
function stem(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

const AFFIXES: readonly RegExp[] = [/\.(?:test|spec)$/, /^test_/, /_(?:test|spec)$/, /Tests?$/];

/** The name a test file tests: `util.test.ts`, `test_util.py` and `UtilTest.php` → the source's. */
function testedStem(path: string): string {
  let name = stem(path);
  for (const affix of AFFIXES) name = name.replace(affix, '');
  return name;
}

/**
 * Whether `test` is a test of `source`: a test file named after it, beside it, in a `__tests__`
 * folder beside it, or anywhere under a test folder (`tests/test_util.py` for `src/pkg/util.py`).
 */
export function isTestOf(test: string, source: string): boolean {
  if (test === source || !isTestPath(test) || isTestPath(source)) return false;
  if (testedStem(test) !== stem(source)) return false;
  const dir = dirname(test);
  const home = dirname(source);
  return (
    dir === home ||
    dir === (home === '' ? '__tests__' : `${home}/__tests__`) ||
    TEST_DIR.test(`${dir}/`)
  );
}

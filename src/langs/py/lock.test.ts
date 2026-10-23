import { describe, expect, it } from 'vitest';
import { normalize, parseEnvironment } from './environment.js';
import { devOnlyDistributions, devOnlyModules } from './lock.js';

// Recorded from uv 0.11 (`uv lock`), with each package's sdist and wheels left out.
const LOCK = `version = 1
revision = 3
requires-python = ">=3.12"

[[package]]
name = "app"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "iniconfig" },
]

[package.optional-dependencies]
color = [
    { name = "colorama" },
]

[package.dev-dependencies]
dev = [
    { name = "pytest" },
]

[package.metadata]
requires-dist = [
    { name = "colorama", marker = "extra == 'color'", specifier = "==0.4.6" },
    { name = "iniconfig", specifier = "==2.3.0" },
]
provides-extras = ["color"]

[package.metadata.requires-dev]
dev = [{ name = "pytest", specifier = "==9.1.1" }]

[[package]]
name = "colorama"
version = "0.4.6"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "iniconfig"
version = "2.3.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "packaging"
version = "26.3"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pluggy"
version = "1.7.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pygments"
version = "2.21.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pytest"
version = "9.1.1"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "colorama", marker = "sys_platform == 'win32'" },
    { name = "iniconfig" },
    { name = "packaging" },
    { name = "pluggy" },
    { name = "pygments" },
]
`;

describe('devOnlyDistributions', () => {
  it('keeps what only the dependency groups reach', () => {
    expect([...(devOnlyDistributions(LOCK) ?? [])].sort((a, b) => a.localeCompare(b))).toEqual([
      'packaging',
      'pluggy',
      'pygments',
      'pytest',
    ]);
  });

  it('follows extras a dependency asks for', () => {
    const lock = `${LOCK}
[[package]]
name = "lib"
version = "1.0"
source = { editable = "lib" }
dependencies = [{ name = "plugin", extra = ["fancy"] }]

[[package]]
name = "plugin"
version = "1.0"
source = { registry = "https://pypi.org/simple" }

[package.optional-dependencies]
fancy = [{ name = "pygments" }]
`;
    const devOnly = devOnlyDistributions(lock);
    expect(devOnly?.has('pygments')).toBe(false);
    expect(devOnly?.has('pytest')).toBe(true);
  });

  it('is undefined for text that is not a lock', () => {
    expect(devOnlyDistributions('not = [toml')).toBeUndefined();
    expect(devOnlyDistributions('package = 3')).toBeUndefined();
  });
});

describe('devOnlyModules', () => {
  // Recorded from the environment script on the clean test project (trimmed).
  const env = parseEnvironment(
    JSON.stringify({
      versions: { pytest: '9.1.1', Pygments: '2.21.0', iniconfig: '2.3.0' },
      modules: {
        _pytest: ['pytest'],
        pytest: ['pytest'],
        py: ['pytest'],
        pygments: ['Pygments'],
        iniconfig: ['iniconfig'],
        __editable___app_finder: ['app'],
        shared: ['pytest', 'iniconfig'],
      },
    }),
  );

  it('lists modules every provider of which is dev-only', () => {
    expect(devOnlyModules(new Set(['pytest', 'pygments']), env)).toEqual([
      '_pytest',
      'py',
      'pygments',
      'pytest',
    ]);
  });

  it('normalizes distribution names as the index does', () => {
    expect(env.versions.get('pygments')).toBe('2.21.0');
    expect(normalize('Import_Linter')).toBe('import-linter');
    expect(normalize('typing.extensions')).toBe('typing-extensions');
  });
});

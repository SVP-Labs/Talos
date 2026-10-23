import { describe, expect, it } from 'vitest';
import { dependencyLine, parseMachete } from './machete.js';

const TAB = '\t';

/** Recorded from cargo-machete 0.9.2 in a workspace root. */
const REPORT = `Analyzing dependencies of crates in this directory...
cargo-machete found the following unused dependencies in this directory:
demo-core -- ./core/Cargo.toml:
${TAB}itoa
${TAB}serde
demo-app -- .\\app\\Cargo.toml:
${TAB}log

If you believe cargo-machete has detected an unused dependency incorrectly,
you can add the dependency to the list of dependencies to ignore in the
\`[package.metadata.cargo-machete]\` section of the appropriate Cargo.toml.
For example:

[package.metadata.cargo-machete]
ignored = ["prost"]

Done!
`;

describe('parseMachete', () => {
  it('reads each crate’s unused dependencies, whatever the path separator', () => {
    expect(parseMachete(REPORT)).toEqual([
      { crate: 'demo-core', manifest: './core/Cargo.toml', dependency: 'itoa' },
      { crate: 'demo-core', manifest: './core/Cargo.toml', dependency: 'serde' },
      { crate: 'demo-app', manifest: './app/Cargo.toml', dependency: 'log' },
    ]);
  });

  it('reads nothing from a clean run', () => {
    expect(parseMachete('Analyzing dependencies of crates in this directory...\nDone!\n')).toEqual(
      [],
    );
  });
});

describe('dependencyLine', () => {
  const manifest = [
    '[package]',
    'name = "demo"',
    'itoa = "not a dependency"',
    '',
    '[dependencies]',
    'serde = { version = "1" }',
    '',
    '[dev-dependencies.itoa]',
    'version = "1"',
    '',
    "[target.'cfg(windows)'.dependencies]",
    '"windows-sys" = "0.61"',
  ].join('\n');

  it('finds an entry in any dependency table, or the table named after it', () => {
    expect(dependencyLine(manifest, 'serde')).toBe(6);
    expect(dependencyLine(manifest, 'itoa')).toBe(8);
    expect(dependencyLine(manifest, 'windows-sys')).toBe(12);
    expect(dependencyLine(manifest, 'absent')).toBe(1);
  });
});

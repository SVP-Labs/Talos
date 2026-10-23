import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { startDraft } from './draft.js';
import { pinToolchain, rustLints, rustToolchain, withLints } from './rust.js';
import type { Component } from '../core/check.js';
import { lintsBlock } from '../langs/rust/lints.js';
import { RUST_CHANNEL } from '../langs/rust/toolchain.js';

const CORE: Component = { lang: 'rust', root: 'core', os: ['linux'] };

function draftOf(texts: Record<string, string>) {
  return startDraft(Object.keys(texts), (path) => texts[path]);
}

describe('withLints', () => {
  it("writes the lint table a lone package lacks, as the gate's levels", () => {
    const text = '[package]\nname = "core"\n';
    expect(withLints(text, 'lints').text).toBe(`${text}\n${lintsBlock('lints')}`);
  });

  it("adds what is missing, raises what is weaker and keeps the project's own", () => {
    const text = [
      '[workspace]',
      'members = ["a"]',
      '',
      '[workspace.lints.rust]',
      '# Reviewed: forbidden outright.',
      'unsafe_code = "forbid"',
      '',
      '[workspace.lints.clippy]',
      'pedantic = { level = "allow", priority = -1 }',
      'unwrap_used = "deny"',
      'missing_docs_in_private_items = "warn"',
      '',
      '[profile.release]',
      'lto = true',
      '',
    ].join('\n');
    const edit = withLints(text, 'workspace.lints');
    expect(edit.manual).toBeUndefined();
    const clippy = parse(edit.text ?? '');
    expect(clippy).toMatchObject({
      workspace: {
        lints: {
          rust: { unsafe_code: 'forbid' },
          clippy: {
            pedantic: { level: 'warn', priority: -1 },
            unwrap_used: 'deny',
            missing_docs_in_private_items: 'warn',
            all: { level: 'warn', priority: -1 },
            todo: 'warn',
          },
        },
      },
      profile: { release: { lto: true } },
    });
    expect(edit.text).toContain('# Reviewed: forbidden outright.\n');
    expect(edit.text).toContain('unimplemented = "warn"\n\n[profile.release]');
    expect(withLints(edit.text ?? '', 'workspace.lints')).toEqual({});
  });

  it('adds a tool table the others are beside', () => {
    const edit = withLints('[lints.rust]\nunsafe_code = "deny"\n', 'lints');
    expect(edit.text).toBe(`${lintsBlock('lints').trimEnd()}\n`);
  });

  it('leaves to a person a table it cannot edit as text', () => {
    expect(withLints('[lints]\nclippy.pedantic = "warn"\n', 'lints').manual).toMatch(
      /laid out unusually/,
    );
    expect(withLints('[lints.clippy]\ntodo = [\n"warn"]\n', 'lints').manual).toMatch(/safely/);
    expect(withLints('[package', 'lints').manual).toMatch(/not valid TOML/);
  });
});

describe('rustLints', () => {
  it('points the members of a workspace at its levels', () => {
    const draft = draftOf({
      'core/Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/old"]\n',
      'core/crates/a/Cargo.toml': '[package]\nname = "a"\n',
      'core/crates/b/Cargo.toml': '[package]\nname = "b"\n\n[lints]\nworkspace = true\n',
      'core/crates/old/Cargo.toml': '[package]\nname = "old"\n',
      'core/crates/c/Cargo.toml': '[package]\nname = "c"\n\n[lints.rust]\nunsafe_code = "deny"\n',
    });
    rustLints(draft, CORE);
    const done = draft.done();
    expect(done.write.map((f) => f.path)).toEqual([
      'core/Cargo.toml',
      'core/crates/a/Cargo.toml',
      'core/crates/c/Cargo.toml',
    ]);
    expect(draft.read('core/crates/a/Cargo.toml')).toBe(
      '[package]\nname = "a"\n\n[lints]\nworkspace = true\n',
    );
    expect(draft.read('core/Cargo.toml')).toContain('[workspace.lints.clippy]');
    expect(draft.read('core/crates/c/Cargo.toml')).toContain('[lints.clippy]');
    expect(done.next).toEqual([]);
  });

  it('gives a workspace root that is a package the workspace levels too', () => {
    const draft = draftOf({ 'core/Cargo.toml': '[package]\nname = "x"\n\n[workspace]\n' });
    rustLints(draft, CORE);
    expect(parse(draft.read('core/Cargo.toml') ?? '')).toMatchObject({
      lints: { workspace: true },
      workspace: { lints: { rust: { unsafe_code: 'deny' } } },
    });
  });

  it('says what it could not write', () => {
    const draft = draftOf({ 'core/Cargo.toml': '[lints]\nclippy.all = "warn"\n' });
    rustLints(draft, CORE);
    expect(draft.done().next).toEqual([
      "in core: write Talos's lint levels into core/Cargo.toml by hand: its [lints] is laid out " +
        'unusually',
    ]);
    const none = draftOf({});
    rustLints(none, CORE);
    expect(none.done()).toEqual({ write: [], delete: [], next: [] });
  });
});

describe('the toolchain', () => {
  it('writes an exact toolchain with the components the checks use', () => {
    const draft = draftOf({ 'core/Cargo.toml': '' });
    rustToolchain(draft, CORE);
    expect(draft.read('core/rust-toolchain.toml')).toBe(
      `[toolchain]\nchannel = "${RUST_CHANNEL}"\ncomponents = ["clippy", "rustfmt", "llvm-tools"]\n` +
        'profile = "minimal"\n',
    );
  });

  it("keeps an exact channel, adds missing components, and pins a floating one at Talos's", () => {
    expect(
      pinToolchain('[toolchain]\nchannel = "1.97.0"\ncomponents = ["clippy", "rustfmt"]\n').text,
    ).toBe('[toolchain]\nchannel = "1.97.0"\ncomponents = ["clippy", "rustfmt", "llvm-tools"]\n');
    expect(pinToolchain('[toolchain]\nchannel = "stable"\nprofile = "minimal"\n').text).toBe(
      `[toolchain]\ncomponents = ["clippy", "rustfmt", "llvm-tools"]\nchannel = "${RUST_CHANNEL}"\n` +
        'profile = "minimal"\n',
    );
    const done =
      '[toolchain]\nchannel = "1.97.0"\ncomponents = ["llvm-tools", "rustfmt", "clippy"]\n';
    expect(pinToolchain(done)).toEqual({});
    expect(pinToolchain('channel = "1.97.0"\n').manual).toMatch(/no \[toolchain\]/);
    expect(pinToolchain('[toolchain]\ncomponents = [\n"x"]\n').manual).toMatch(/safely/);
  });

  it('edits the file rustup reads, above the component when that is where it is', () => {
    const draft = draftOf({
      'rust-toolchain.toml': '[toolchain]\nchannel = "1.97.0"\ncomponents = ["clippy"]\n',
      'core/Cargo.toml': '',
    });
    rustToolchain(draft, CORE);
    expect(draft.done().write.map((f) => f.path)).toEqual(['rust-toolchain.toml']);
  });

  it('turns the legacy one-line file into the TOML one', () => {
    const draft = draftOf({ 'core/rust-toolchain': '1.96.0\n', 'core/Cargo.toml': '' });
    rustToolchain(draft, CORE);
    const done = draft.done();
    expect(done.delete).toEqual([{ path: 'core/rust-toolchain', why: 'migrated' }]);
    expect(draft.read('core/rust-toolchain.toml')).toContain('channel = "1.96.0"');
    const toml = draftOf({
      'core/rust-toolchain': '[toolchain]\nchannel = "1.95.0"\ncomponents = ["miri"]\n',
      'core/Cargo.toml': '',
    });
    rustToolchain(toml, CORE);
    expect(toml.read('core/rust-toolchain.toml')).toBe(
      '[toolchain]\nchannel = "1.95.0"\ncomponents = ["miri", "clippy", "rustfmt", "llvm-tools"]\n',
    );
    const unusual = draftOf({ 'core/rust-toolchain.toml': 'channel = 1\n', 'core/Cargo.toml': '' });
    rustToolchain(unusual, CORE);
    expect(unusual.done().next[0]).toMatch(/pin the toolchain by hand/);
  });
});

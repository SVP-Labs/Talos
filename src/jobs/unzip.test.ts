import { describe, expect, it } from 'vitest';
import { ZipError, zipEntry } from './unzip.js';
import { makeZip } from '../ticket/test/fake-github.js';

const MB = 1024 * 1024;

describe('zipEntry', () => {
  it('reads a deflated entry', () => {
    const zip = makeZip({ 'other.txt': 'no', 'verdict.json': '{"a":1}' });
    expect(zipEntry(zip, 'verdict.json', MB)?.toString('utf8')).toBe('{"a":1}');
  });

  it('reads a stored entry', () => {
    const zip = makeZip({ 'verdict.json': 'plain' }, { stored: true });
    expect(zipEntry(zip, 'verdict.json', MB)?.toString('utf8')).toBe('plain');
  });

  it('reads sizes from the directory when the local header has none', () => {
    const zip = makeZip(
      { 'a.txt': 'x'.repeat(1000), 'verdict.json': '{"b":2}' },
      { streamed: true },
    );
    expect(zipEntry(zip, 'verdict.json', MB)?.toString('utf8')).toBe('{"b":2}');
  });

  it('reads a slice of a larger buffer', () => {
    const zip = makeZip({ 'v.json': 'in a slice' });
    const padded = new Uint8Array(zip.length + 8);
    padded.set(zip, 4);
    expect(zipEntry(padded.subarray(4, 4 + zip.length), 'v.json', MB)?.toString()).toBe(
      'in a slice',
    );
  });

  it('answers undefined when the entry is missing', () => {
    expect(zipEntry(makeZip({ 'a.txt': 'x' }), 'verdict.json', MB)).toBeUndefined();
    expect(zipEntry(makeZip({}), 'verdict.json', MB)).toBeUndefined();
  });

  it('refuses an entry larger than allowed, even one that claims to be small', () => {
    const zip = makeZip({ 'big.json': 'x'.repeat(5000) });
    expect(() => zipEntry(zip, 'big.json', 100)).toThrow(ZipError);
    const lying = Buffer.from(makeZip({ 'big.json': 'x'.repeat(5000) }));
    const directory = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lying.writeUInt32LE(10, directory + 24);
    expect(() => zipEntry(lying, 'big.json', 100)).toThrow(/output length|larger/i);
  });

  it('refuses what is not a zip archive, or a damaged one', () => {
    expect(() => zipEntry(Buffer.from('short'), 'x', MB)).toThrow(ZipError);
    expect(() => zipEntry(Buffer.alloc(100), 'x', MB)).toThrow(/not a zip/);
    const broken = Buffer.from(makeZip({ 'v.json': 'x' }));
    broken.writeUInt32LE(0, 0);
    expect(() => zipEntry(broken, 'v.json', MB)).toThrow(/local header/);
    const method = Buffer.from(makeZip({ 'v.json': 'x' }, { stored: true }));
    const entry = method.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    method.writeUInt16LE(12, entry + 10);
    expect(() => zipEntry(method, 'v.json', MB)).toThrow(/compression method 12/);
  });
});

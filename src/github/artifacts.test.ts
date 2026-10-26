import { describe, expect, it } from 'vitest';
import { GitHubError } from './api.js';
import { downloader, extractFile, readArtifactFile } from './artifacts.js';
import { EngineError } from '../core/check.js';
import { type FakeArtifact, FakeGitHub, makeZip } from '../ticket/test/fake-github.js';

const DIRECTORY_ENTRY = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const END_OF_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** A copy of the archive with `edit` applied to its bytes. */
function edited(zip: Uint8Array, edit: (bytes: Buffer) => void): Buffer {
  const bytes = Buffer.from(zip);
  edit(bytes);
  return bytes;
}

/** The offset of the first central directory entry, whose fields the tests rewrite. */
function entryOf(bytes: Buffer): number {
  return bytes.indexOf(DIRECTORY_ENTRY);
}

function refused(archive: Uint8Array, file: string, why: RegExp): void {
  expect(() => extractFile(archive, file)).toThrow(EngineError);
  expect(() => extractFile(archive, file)).toThrow(why);
}

describe('extractFile', () => {
  it('reads a deflated file, as actions/upload-artifact writes one', () => {
    const zip = makeZip({ 'talos.sarif': '{}', 'verdict.json': '{"status":"red"}' });
    expect(extractFile(zip, 'verdict.json')).toBe('{"status":"red"}');
  });

  it('reads a stored file, and one whose local header leaves its sizes to the directory', () => {
    expect(extractFile(makeZip({ 'v.json': 'plain' }, { stored: true }), 'v.json')).toBe('plain');
    const streamed = makeZip(
      { 'a.txt': 'x'.repeat(1000), 'dir/v.json': '{"b":2}' },
      { streamed: true },
    );
    expect(extractFile(streamed, 'dir/v.json')).toBe('{"b":2}');
  });

  it('reads an archive that is a slice of a larger buffer', () => {
    const zip = makeZip({ 'v.json': 'in a slice' });
    const padded = new Uint8Array(zip.length + 8);
    padded.set(zip, 4);
    expect(extractFile(padded.subarray(4, 4 + zip.length), 'v.json')).toBe('in a slice');
  });

  it('is undefined for a file the archive lacks', () => {
    expect(extractFile(makeZip({ 'other.json': '{}' }), 'verdict.json')).toBeUndefined();
    expect(extractFile(makeZip({}), 'verdict.json')).toBeUndefined();
  });

  it('asks only for plain names inside the archive', () => {
    const zip = makeZip({ 'v.json': '{}' });
    for (const name of ['-p', '*.json', '../x', 'a/../../b', '', '/etc/passwd', 'C:/x']) {
      expect(() => extractFile(zip, name)).toThrow(TypeError);
    }
  });

  it('refuses an archive holding a name with .. or an absolute path, whatever is asked', () => {
    for (const hostile of ['../evil.sh', 'a/../../evil', '/etc/cron.d/x', 'C:\\x', '..\\x']) {
      const zip = makeZip({ 'verdict.json': '{}', [hostile]: 'x' });
      refused(zip, 'verdict.json', /absolute path or \.\./);
    }
  });

  it('refuses what is not a zip archive, or a damaged one', () => {
    refused(Buffer.from('short'), 'v.json', /not a zip archive/);
    refused(Buffer.alloc(100), 'v.json', /not a zip archive/);
    const zip = makeZip({ 'v.json': 'x'.repeat(200) });
    refused(zip.subarray(0, zip.length - 30), 'v.json', /not a zip archive/);
    refused(
      edited(zip, (bytes) => bytes.writeUInt32LE(0, 0)),
      'v.json',
      /damaged local header/,
    );
    refused(
      edited(zip, (bytes) => bytes.writeUInt32LE(0, entryOf(bytes))),
      'v.json',
      /damaged central directory/,
    );
    const longName = edited(zip, (bytes) => bytes.writeUInt16LE(500, entryOf(bytes) + 28));
    refused(longName, 'v.json', /damaged central directory/);
    const end = (bytes: Buffer): number => bytes.indexOf(END_OF_DIRECTORY);
    refused(
      edited(zip, (bytes) => bytes.writeUInt32LE(bytes.length, end(bytes) + 16)),
      'v.json',
      /outside the archive/,
    );
    const packed = (bytes: Buffer): number => entryOf(bytes) + 20;
    const truncated = edited(zip, (bytes) =>
      bytes.writeUInt32LE(bytes.readUInt32LE(packed(bytes)) + 1000, packed(bytes)),
    );
    refused(truncated, 'v.json', /v\.json is truncated/);
  });

  it('refuses a file whose data is corrupt or fails its checksum', () => {
    const stored = makeZip({ 'v.json': 'plain text' }, { stored: true });
    const flipped = edited(stored, (bytes) => {
      bytes[30 + 'v.json'.length] = 0x41;
    });
    refused(flipped, 'v.json', /checksum/);
    const deflated = makeZip({ 'v.json': 'x'.repeat(500) });
    const garbage = edited(deflated, (bytes) => bytes.fill(0xff, 36, 40));
    refused(garbage, 'v.json', /inflate|checksum/);
  });

  it('refuses encrypted files, other compression methods, zip64 and split archives', () => {
    const zip = makeZip({ 'v.json': 'secret' }, { stored: true });
    const flags = (value: number) => (bytes: Buffer) =>
      bytes.writeUInt16LE(value, entryOf(bytes) + 8);
    refused(edited(zip, flags(0x01)), 'v.json', /encrypted/);
    refused(edited(zip, flags(0x40)), 'v.json', /encrypted/);
    const method = edited(zip, (bytes) => bytes.writeUInt16LE(12, entryOf(bytes) + 10));
    refused(method, 'v.json', /method 12/);
    const end = (bytes: Buffer): number => bytes.indexOf(END_OF_DIRECTORY);
    const count = edited(zip, (bytes) => {
      bytes.writeUInt16LE(0xff_ff, end(bytes) + 8);
      bytes.writeUInt16LE(0xff_ff, end(bytes) + 10);
    });
    refused(count, 'v.json', /zip64/);
    const locator = edited(zip, (bytes) => bytes.writeUInt32LE(0x07_06_4b_50, end(bytes) - 20));
    refused(locator, 'v.json', /zip64/);
    const size = edited(zip, (bytes) => bytes.writeUInt32LE(0xff_ff_ff_ff, entryOf(bytes) + 24));
    refused(size, 'v.json', /zip64/);
    const disk = edited(zip, (bytes) => bytes.writeUInt16LE(1, end(bytes) + 4));
    refused(disk, 'v.json', /split across disks/);
  });

  it('refuses a file larger than allowed, even one that claims to be small', () => {
    const zip = makeZip({ 'big.json': 'x'.repeat(5000) });
    expect(() => extractFile(zip, 'big.json', 100)).toThrow(/larger than 100 bytes/);
    expect(extractFile(zip, 'big.json', 5000)).toHaveLength(5000);
    const lying = edited(zip, (bytes) => bytes.writeUInt32LE(10, entryOf(bytes) + 24));
    expect(() => extractFile(lying, 'big.json', 100)).toThrow(/does not inflate to its 10 bytes/);
  });
});

describe('readArtifactFile', () => {
  const wanted = { repo: 'o/r', runId: 11, artifact: 'talos-verdict', file: 'verdict.json' };

  function fakeWith(artifact: Partial<FakeArtifact>): FakeGitHub {
    const fake = new FakeGitHub();
    const zip = makeZip({ 'verdict.json': '{"ok":true}' });
    fake.artifacts.push({
      id: 2,
      run: 11,
      name: 'talos-verdict',
      created_at: '2026-10-23T10:00:00Z',
      expired: false,
      size_in_bytes: zip.length,
      zip,
      ...artifact,
    });
    return fake;
  }

  async function read(fake: FakeGitHub, file = 'verdict.json'): Promise<string | undefined> {
    const download = downloader('t', { fetch: fake.fetch });
    return readArtifactFile(fake.client(), download, { ...wanted, file });
  }

  it("downloads the run's named artifact and reads the file in memory", async () => {
    const fake = fakeWith({});
    expect(await read(fake)).toBe('{"ok":true}');
    expect(fake.calls.map((call) => call.path)).toEqual([
      'repos/o/r/actions/runs/11/artifacts',
      'repos/o/r/actions/artifacts/2/zip',
      'storage/2',
    ]);
  });

  it('is undefined for a missing or expired artifact, or one without the file', async () => {
    expect(await read(fakeWith({ name: 'something-else' }))).toBeUndefined();
    expect(await read(fakeWith({ expired: true }))).toBeUndefined();
    expect(await read(fakeWith({}), 'talos.sarif')).toBeUndefined();
  });

  it('refuses an archive over 100 MB, listed or downloaded, and one it cannot read', async () => {
    const huge = fakeWith({ size_in_bytes: 200 * 1024 * 1024 });
    await expect(read(huge)).rejects.toBeInstanceOf(GitHubError);
    const lying = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(101 * 1024 * 1024));
    await expect(readArtifactFile(fakeWith({}).client(), lying, wanted)).rejects.toThrow(
      /over 104857600 bytes/,
    );
    const damaged = fakeWith({ zip: new TextEncoder().encode('not a zip at all') });
    await expect(read(damaged)).rejects.toBeInstanceOf(EngineError);
  });
});

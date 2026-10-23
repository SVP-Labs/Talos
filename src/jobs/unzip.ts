import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of the zip format to read one small file out of a workflow artifact: the central
 * directory, stored and deflated entries, no zip64. Sizes come from the central directory,
 * since `actions/upload-artifact` streams entries and leaves the local headers' sizes at zero.
 */

const END_OF_DIRECTORY = 0x06_05_4b_50;
const DIRECTORY_ENTRY = 0x02_01_4b_50;
const LOCAL_HEADER = 0x04_03_4b_50;
const END_SIZE = 22;
const MAX_COMMENT = 0xff_ff;

export class ZipError extends Error {
  override readonly name = 'ZipError';
}

function endOfDirectory(zip: Buffer): number {
  const last = zip.length - END_SIZE;
  for (let at = last; at >= Math.max(0, last - MAX_COMMENT); at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  throw new ZipError('not a zip archive');
}

type Entry = {
  readonly method: number;
  readonly compressed: number;
  readonly size: number;
  readonly local: number;
};

function extract(zip: Buffer, entry: Entry, maxBytes: number): Buffer {
  if (entry.size > maxBytes) throw new ZipError(`entry larger than ${maxBytes} bytes`);
  if (zip.readUInt32LE(entry.local) !== LOCAL_HEADER) throw new ZipError('bad local header');
  const start =
    entry.local + 30 + zip.readUInt16LE(entry.local + 26) + zip.readUInt16LE(entry.local + 28);
  const data = zip.subarray(start, start + entry.compressed);
  if (data.length !== entry.compressed) throw new ZipError('truncated entry');
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new ZipError(`unsupported compression method ${entry.method}`);
}

/** The bytes of the entry called `name`, or `undefined` when the archive has none. */
export function zipEntry(bytes: Uint8Array, name: string, maxBytes: number): Buffer | undefined {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (zip.length < END_SIZE) throw new ZipError('not a zip archive');
  const end = endOfDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new ZipError('bad directory entry');
    const nameLength = zip.readUInt16LE(at + 28);
    const entryName = zip.toString('utf8', at + 46, at + 46 + nameLength);
    if (entryName === name) {
      return extract(
        zip,
        {
          method: zip.readUInt16LE(at + 10),
          compressed: zip.readUInt32LE(at + 20),
          size: zip.readUInt32LE(at + 24),
          local: zip.readUInt32LE(at + 42),
        },
        maxBytes,
      );
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return undefined;
}

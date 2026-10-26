import { crc32, inflateRawSync } from 'node:zlib';
import { listRunArtifacts } from './actions.js';
import { type GitHub, GitHubError, type GitHubOptions } from './api.js';
import { EngineError } from '../core/check.js';

/** A binary GET against the API; the client in `api.ts` reads JSON and text only. */
export type Download = (path: string) => Promise<Uint8Array>;

const API = 'https://api.github.com';
const MAX_ARCHIVE = 100 * 1024 * 1024;
/** The largest file read out of an artifact: a verdict or a report, never a build. */
const MAX_MEMBER = 32 * 1024 * 1024;

export function downloader(token: string, options: GitHubOptions = {}): Download {
  const baseUrl = options.baseUrl ?? API;
  const doFetch = options.fetch ?? fetch;
  return async (path) => {
    const url = path.startsWith('https://') ? path : `${baseUrl}/${path.replace(/^\//, '')}`;
    if (!url.startsWith(`${baseUrl}/`)) throw new GitHubError('GET artifact: not an API URL', 0);
    const first = await doFetch(url, {
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'svp-labs-talos',
      },
    });
    const location = first.headers.get('location');
    // The archive sits behind a short-lived signed URL on a storage host, which must never see
    // the API token, so the redirect is followed by hand and without headers.
    const response =
      first.status >= 300 && first.status < 400 && location !== null
        ? await doFetch(location)
        : first;
    if (!response.ok) throw new GitHubError(`GET ${path}: ${response.status}`, response.status);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/*
 * Just enough of the zip format to read one file of a workflow artifact with no program outside
 * Node: the end of central directory record, the central directory, one local header, stored and
 * deflated data. Sizes and checksums come from the central directory, since
 * `actions/upload-artifact` streams its entries and leaves the local headers' at zero.
 */

const END_OF_DIRECTORY = 0x06_05_4b_50;
const ZIP64_LOCATOR = 0x07_06_4b_50;
const DIRECTORY_ENTRY = 0x02_01_4b_50;
const LOCAL_HEADER = 0x04_03_4b_50;
const END_SIZE = 22;
const LOCATOR_SIZE = 20;
const ENTRY_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xff_ff;
/** What a 16- or 32-bit field holds when the real value is in a zip64 record. */
const ZIP64_COUNT = 0xff_ff;
const ZIP64_SIZE = 0xff_ff_ff_ff;
/** General purpose flags: bit 0, encrypted; bit 6, strongly encrypted. */
const ENCRYPTED = 0x00_41;
const STORED = 0;
const DEFLATED = 8;

type Member = {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly packed: number;
  readonly size: number;
  readonly local: number;
};

type Directory = { readonly start: number; readonly end: number; readonly count: number };

function refuse(why: string): never {
  throw new EngineError(`unreadable artifact: ${why}`);
}

/** Where the end of central directory record starts: the last one whose comment ends the file. */
function endRecord(zip: Buffer): number {
  const last = zip.length - END_SIZE;
  for (let at = last; at >= Math.max(0, last - MAX_COMMENT); at -= 1) {
    if (
      zip.readUInt32LE(at) === END_OF_DIRECTORY &&
      at + END_SIZE + zip.readUInt16LE(at + 20) === zip.length
    ) {
      return at;
    }
  }
  return refuse('not a zip archive');
}

function directoryOf(zip: Buffer): Directory {
  if (zip.length < END_SIZE) refuse('not a zip archive');
  const end = endRecord(zip);
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const start = zip.readUInt32LE(end + 16);
  const zip64 = end >= LOCATOR_SIZE && zip.readUInt32LE(end - LOCATOR_SIZE) === ZIP64_LOCATOR;
  if (zip64 || count === ZIP64_COUNT || size === ZIP64_SIZE || start === ZIP64_SIZE) {
    refuse('a zip64 archive');
  }
  // This disk's number and the central directory's, both 16 bits, read as one.
  if (zip.readUInt32LE(end + 4) !== 0 || zip.readUInt16LE(end + 8) !== count) {
    refuse('an archive split across disks');
  }
  if (start + size > end) refuse('the central directory lies outside the archive');
  return { start, end: start + size, count };
}

/** A name that could write outside a directory: absolute, with a drive, `..` or a NUL in it. */
function hostile(name: string): boolean {
  return (
    name === '' ||
    name.includes('\0') ||
    /^(?:[/\\]|[a-z]:)/i.test(name) ||
    name.split(/[/\\]/).includes('..')
  );
}

function memberAt(zip: Buffer, at: number, directory: Directory): [Member, number] {
  if (at + ENTRY_SIZE > directory.end || zip.readUInt32LE(at) !== DIRECTORY_ENTRY) {
    refuse('a damaged central directory');
  }
  const nameEnd = at + ENTRY_SIZE + zip.readUInt16LE(at + 28);
  const next = nameEnd + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  if (next > directory.end) refuse('a damaged central directory');
  const name = zip.toString('utf8', at + ENTRY_SIZE, nameEnd);
  if (hostile(name)) refuse('a file named with an absolute path or ..');
  const member = {
    name,
    flags: zip.readUInt16LE(at + 8),
    method: zip.readUInt16LE(at + 10),
    crc: zip.readUInt32LE(at + 16),
    packed: zip.readUInt32LE(at + 20),
    size: zip.readUInt32LE(at + 24),
    local: zip.readUInt32LE(at + 42),
  };
  return [member, next];
}

/** Every file the central directory lists; one hostile name refuses the whole archive. */
function members(zip: Buffer): { listed: Member[]; directory: Directory } {
  const directory = directoryOf(zip);
  const listed: Member[] = [];
  let at = directory.start;
  for (let index = 0; index < directory.count; index += 1) {
    const [member, next] = memberAt(zip, at, directory);
    listed.push(member);
    at = next;
  }
  return { listed, directory };
}

/** The member's data as stored, checked against its own entry before anything is inflated. */
function packedData(zip: Buffer, member: Member, directory: Directory, maxBytes: number): Buffer {
  const { name } = member;
  if ((member.flags & ENCRYPTED) !== 0) refuse(`${name} is encrypted`);
  if ([member.packed, member.size, member.local].includes(ZIP64_SIZE)) refuse(`${name} is zip64`);
  if (member.size > maxBytes) refuse(`${name} is larger than ${maxBytes} bytes`);
  if (member.method !== STORED && member.method !== DEFLATED) {
    refuse(`${name} is compressed with method ${member.method}`);
  }
  const local = member.local;
  if (local + LOCAL_SIZE > directory.start || zip.readUInt32LE(local) !== LOCAL_HEADER) {
    refuse(`${name} has a damaged local header`);
  }
  const start = local + LOCAL_SIZE + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  if (start + member.packed > directory.start) refuse(`${name} is truncated`);
  return zip.subarray(start, start + member.packed);
}

function unpacked(data: Buffer, member: Member): Buffer {
  if (member.method === STORED) return data;
  try {
    // A member that inflates past the size its entry gives is refused before it is all in memory.
    return inflateRawSync(data, { maxOutputLength: Math.max(1, member.size) });
  } catch {
    return refuse(`${member.name} does not inflate to its ${member.size} bytes`);
  }
}

/**
 * One file of a zip archive as text, read in-process; `undefined` when the archive lacks it.
 * An archive Talos can't read safely (damaged, encrypted, zip64, another compression method, a
 * file over `maxBytes`, a name with `..` or an absolute path) throws an `EngineError`.
 */
export function extractFile(
  archive: Uint8Array,
  file: string,
  maxBytes: number = MAX_MEMBER,
): string | undefined {
  if (hostile(file) || !/^\w[\w./-]*$/.test(file)) {
    throw new TypeError(`not a plain file name inside an archive: ${file}`);
  }
  const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const { listed, directory } = members(zip);
  const member = listed.find((candidate) => candidate.name === file);
  if (member === undefined) return undefined;
  const data = unpacked(packedData(zip, member, directory, maxBytes), member);
  if (data.length !== member.size || crc32(data) !== member.crc) {
    refuse(`${file} fails its checksum`);
  }
  return data.toString('utf8');
}

function tooLarge(name: string): GitHubError {
  return new GitHubError(`artifact ${name} is over ${MAX_ARCHIVE} bytes`, 413);
}

export type ArtifactFile = {
  readonly repo: string;
  readonly runId: number;
  /** The artifact's name, such as `talos-verdict`. */
  readonly artifact: string;
  /** The file inside it, such as `verdict.json`. */
  readonly file: string;
};

/**
 * A file from a workflow run's artifact, read in memory; `undefined` when the run has no such
 * artifact, it expired, or it lacks the file. An archive it can't read throws an `EngineError`.
 */
export async function readArtifactFile(
  gh: GitHub,
  download: Download,
  wanted: ArtifactFile,
): Promise<string | undefined> {
  const artifacts = await listRunArtifacts(gh, wanted.repo, wanted.runId);
  const artifact = artifacts.find((a) => a.name === wanted.artifact && !a.expired);
  if (artifact === undefined) return undefined;
  if (artifact.size_in_bytes > MAX_ARCHIVE) throw tooLarge(artifact.name);
  const archive = await download(`repos/${wanted.repo}/actions/artifacts/${artifact.id}/zip`);
  if (archive.byteLength > MAX_ARCHIVE) throw tooLarge(artifact.name);
  return extractFile(archive, wanted.file);
}

import { parse } from 'yaml';
import { z } from 'zod';
import {
  before,
  fromFile,
  fromGit,
  fromUrl,
  LOCAL,
  type Locked,
  npmSource,
  PUBLIC_REGISTRY,
  type Source,
  splitSpec,
} from './locked.js';

function unquote(text: string): string {
  return text.trim().replace(/^"(.*)"$/, '$1');
}

type Block = { name: string; version?: string; resolved?: string };

function v1Blocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^[^\s#].*:$/.test(line)) {
      const first = unquote(line.slice(0, -1).split(', ')[0] ?? '');
      current = { name: splitSpec(first).name };
      blocks.push(current);
      continue;
    }
    const field = /^ {2}(version|resolved) (.+)$/.exec(line);
    if (current !== undefined && field?.[1] !== undefined && field[2] !== undefined) {
      current[field[1] === 'version' ? 'version' : 'resolved'] = unquote(field[2]);
    }
  }
  return blocks;
}

/** Yarn 1's own format: blocks of `version` and `resolved`, a registry URL ending `#<sha1>`. */
function parseV1(text: string): Locked[] {
  return v1Blocks(text).map((block) => {
    const version = block.version ?? '0.0.0';
    const resolved = block.resolved?.replace(/^(https?:.*)#[0-9a-f]{40}$/, '$1');
    return {
      ecosystem: 'npm',
      name: block.name,
      version,
      source: resolved === undefined ? PUBLIC_REGISTRY : npmSource(block.name, version, resolved),
    };
  });
}

const berryEntry = z.looseObject({
  version: z.string().optional(),
  resolution: z.string().optional(),
});

const LOCAL_PROTOCOLS = ['workspace:', 'portal:', 'link:'];

/** A Yarn 2+ resolution's protocol: `npm:`, `workspace:`, `patch:` around another, a URL, git. */
function berrySource(name: string, version: string, reference: string): Source {
  if (reference.startsWith('npm:')) return PUBLIC_REGISTRY;
  if (LOCAL_PROTOCOLS.some((protocol) => reference.startsWith(protocol))) return LOCAL;
  if (reference.startsWith('patch:')) {
    const inner = decodeURIComponent(before(reference.slice('patch:'.length), ['#']));
    return berrySource(name, version, splitSpec(inner).rest);
  }
  if (reference.startsWith('file:')) return fromFile(before(reference.slice(5), ['#', ':']));
  if (/#commit=|\.git(?:#|$)|^(?:git[+:@]|github:)/.test(reference)) return fromGit(reference);
  if (/^https?:/.test(reference)) return npmSource(name, version, reference);
  return fromUrl(reference);
}

function parseBerry(text: string): Locked[] {
  const entries = z.record(z.string(), z.unknown()).parse(parse(text));
  return Object.entries(entries).flatMap(([key, value]): Locked[] => {
    if (key === '__metadata') return [];
    const entry = berryEntry.parse(value);
    if (entry.resolution === undefined) return [];
    const { name, rest } = splitSpec(entry.resolution);
    const version = entry.version ?? '0.0.0';
    return [{ ecosystem: 'npm', name, version, source: berrySource(name, version, rest) }];
  });
}

/** `yarn.lock` from Yarn 1 or from Yarn 2 and later, which writes YAML. */
export function parseYarnLock(text: string): Locked[] {
  return /^__metadata:/m.test(text) ? parseBerry(text) : parseV1(text);
}

import { z } from 'zod';
import { type Channel, CHANNELS, type Pins } from './channels.js';
import type { GitHub } from '../github/api.js';

/**
 * `channels.json` on the Talos repository's `channels` branch: each channel's pin, for an
 * organisation whose ruleset listing hides rulesets in Evaluate mode. Only `talos-release` writes
 * it (the branch's own ruleset), right after moving the rulesets it mirrors.
 */

const CHANNELS_FILE = 'channels.json';
const CHANNELS_BRANCH = 'channels';

const SHA = /^[0-9a-f]{40}$/;

/** The file's text for a full set of pins: stable key order, one trailing newline. */
export function channelsText(pins: Pins): string {
  const entries = CHANNELS.map((channel) => [channel, pins[channel] ?? null] as const);
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

/** The channels whose pin the file doesn't hold; every channel when it can't be read. */
export function channelsMismatch(text: string | undefined, pins: Pins): Channel[] {
  let parsed: unknown;
  try {
    parsed = text === undefined ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const record = z.record(z.string(), z.unknown()).safeParse(parsed);
  return CHANNELS.filter((channel) => {
    const value = record.success ? record.data[channel] : undefined;
    return typeof value !== 'string' || !SHA.test(value) || value !== pins[channel];
  });
}

const fileSchema = z.object({
  sha: z.string(),
  content: z.string(),
  encoding: z.literal('base64'),
});

export type ChannelsFile = { readonly text: string; readonly blob: string };

export async function readChannelsFile(
  gh: GitHub,
  repo: string,
): Promise<ChannelsFile | undefined> {
  const raw = await gh.request<unknown>(
    'GET',
    `repos/${repo}/contents/${CHANNELS_FILE}?ref=${CHANNELS_BRANCH}`,
    { allowMissing: true },
  );
  if (raw === undefined) return undefined;
  const file = fileSchema.parse(raw);
  const text = Buffer.from(file.content.replaceAll('\n', ''), 'base64').toString('utf8');
  return { text, blob: file.sha };
}

const shaSchema = z.object({ sha: z.string() });

async function branchExists(gh: GitHub, repo: string): Promise<boolean> {
  const ref = await gh.request<unknown>('GET', `repos/${repo}/git/ref/heads/${CHANNELS_BRANCH}`, {
    allowMissing: true,
  });
  return ref !== undefined;
}

/** The branch's first commit: a tree of the one file, with no parent. */
async function createBranch(
  gh: GitHub,
  repo: string,
  text: string,
  message: string,
): Promise<void> {
  const tree = shaSchema.parse(
    await gh.request<unknown>('POST', `repos/${repo}/git/trees`, {
      body: { tree: [{ path: CHANNELS_FILE, mode: '100644', type: 'blob', content: text }] },
    }),
  );
  const commit = shaSchema.parse(
    await gh.request<unknown>('POST', `repos/${repo}/git/commits`, {
      body: { message, tree: tree.sha, parents: [] },
    }),
  );
  await gh.request('POST', `repos/${repo}/git/refs`, {
    body: { ref: `refs/heads/${CHANNELS_BRANCH}`, sha: commit.sha },
  });
}

/** Writes the pins to the file, creating the branch on the first write. */
export async function writeChannelsFile(
  gh: GitHub,
  repo: string,
  pins: Pins,
  existing: ChannelsFile | undefined,
): Promise<void> {
  const text = channelsText(pins);
  if (existing?.text === text) return;
  const message = 'Move the channel pins';
  if (existing === undefined && !(await branchExists(gh, repo))) {
    await createBranch(gh, repo, text, message);
    return;
  }
  await gh.request('PUT', `repos/${repo}/contents/${CHANNELS_FILE}`, {
    body: {
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch: CHANNELS_BRANCH,
      ...(existing === undefined ? {} : { sha: existing.blob }),
    },
  });
}

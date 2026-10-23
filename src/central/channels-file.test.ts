import { describe, expect, it } from 'vitest';
import {
  channelsMismatch,
  channelsText,
  readChannelsFile,
  writeChannelsFile,
} from './channels-file.js';
import { fakeGitHub } from './test/fake-github.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const PINS = { evaluate: A, canary: B, stable: A };
const encoded = (text: string): string => Buffer.from(text).toString('base64');

describe('channels.json', () => {
  it('writes every channel in a fixed order, null where nothing is pinned', () => {
    expect(channelsText(PINS)).toBe(
      `{\n  "evaluate": "${A}",\n  "canary": "${B}",\n  "stable": "${A}"\n}\n`,
    );
    expect(JSON.parse(channelsText({ evaluate: undefined, canary: B, stable: undefined }))).toEqual(
      { evaluate: null, canary: B, stable: null },
    );
  });

  it('names the channels the file gets wrong', () => {
    expect(channelsMismatch(channelsText(PINS), PINS)).toEqual([]);
    expect(channelsMismatch(JSON.stringify({ ...PINS, canary: A }), PINS)).toEqual(['canary']);
    expect(channelsMismatch(JSON.stringify({ evaluate: A, canary: 'v1' }), PINS)).toEqual([
      'canary',
      'stable',
    ]);
    expect(channelsMismatch(undefined, PINS)).toEqual(['evaluate', 'canary', 'stable']);
    expect(channelsMismatch('not json', PINS)).toEqual(['evaluate', 'canary', 'stable']);
    expect(channelsMismatch('[1]', PINS)).toEqual(['evaluate', 'canary', 'stable']);
    expect(channelsMismatch(channelsText(PINS), { ...PINS, stable: undefined })).toEqual([
      'stable',
    ]);
  });

  it('reads the file from the channels branch, or nothing', async () => {
    const fake = fakeGitHub({
      'GET repos/o/t/contents/channels.json?ref=channels': {
        body: {
          sha: 'blob1',
          content: `${encoded('{}').slice(0, 2)}\n${encoded('{}').slice(2)}`,
          encoding: 'base64',
        },
      },
    });
    expect(await readChannelsFile(fake.gh, 'o/t')).toEqual({ text: '{}', blob: 'blob1' });
    expect(await readChannelsFile(fakeGitHub().gh, 'o/t')).toBeUndefined();
  });

  it('leaves a file that already says it alone', async () => {
    const fake = fakeGitHub();
    await writeChannelsFile(fake.gh, 'o/t', PINS, { text: channelsText(PINS), blob: 'x' });
    expect(fake.calls).toEqual([]);
  });

  it('updates the file in place, or adds it to an existing branch', async () => {
    const fake = fakeGitHub({
      'PUT repos/o/t/contents/channels.json': { status: 200, body: {} },
      'GET repos/o/t/git/ref/heads/channels': { body: { object: { sha: 'c' } } },
    });
    await writeChannelsFile(fake.gh, 'o/t', PINS, { text: '{}', blob: 'blob1' });
    await writeChannelsFile(fake.gh, 'o/t', PINS, undefined);
    const puts = fake.calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    expect(puts).toEqual([
      {
        message: 'Move the channel pins',
        content: encoded(channelsText(PINS)),
        branch: 'channels',
        sha: 'blob1',
      },
      {
        message: 'Move the channel pins',
        content: encoded(channelsText(PINS)),
        branch: 'channels',
      },
    ]);
  });

  it('creates the branch with one commit and no parent on the first write', async () => {
    const fake = fakeGitHub({
      'POST repos/o/t/git/trees': { status: 201, body: { sha: 'tree1' } },
      'POST repos/o/t/git/commits': { status: 201, body: { sha: 'commit1' } },
      'POST repos/o/t/git/refs': { status: 201, body: { ref: 'refs/heads/channels' } },
    });
    await writeChannelsFile(fake.gh, 'o/t', PINS, undefined);
    expect(fake.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', 'repos/o/t/git/ref/heads/channels', undefined],
      [
        'POST',
        'repos/o/t/git/trees',
        {
          tree: [
            { path: 'channels.json', mode: '100644', type: 'blob', content: channelsText(PINS) },
          ],
        },
      ],
      [
        'POST',
        'repos/o/t/git/commits',
        { message: 'Move the channel pins', tree: 'tree1', parents: [] },
      ],
      ['POST', 'repos/o/t/git/refs', { ref: 'refs/heads/channels', sha: 'commit1' }],
    ]);
  });
});

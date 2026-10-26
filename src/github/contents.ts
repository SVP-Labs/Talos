import { z } from 'zod';
import { type GitHub, GitHubError } from './api.js';

const fileSchema = z.object({
  type: z.literal('file'),
  encoding: z.string(),
  content: z.string(),
  sha: z.string(),
});

const blobSchema = z.object({ encoding: z.literal('base64'), content: z.string() });

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/');
}

function decode(base64: string): string {
  return Buffer.from(base64.replaceAll('\n', ''), 'base64').toString('utf8');
}

/**
 * A file's text at a ref (branch, tag or commit SHA) through the contents API, or `undefined`
 * when the path doesn't exist there.
 */
export async function readFileAt(
  gh: GitHub,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  const url = `repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
  const raw = await gh.request<unknown>('GET', url, { allowMissing: true });
  if (raw === undefined) return undefined;
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new GitHubError(`GET contents of ${path} at ${ref}: not a file`, 200);
  if (parsed.data.encoding === 'base64') return decode(parsed.data.content);
  // Files over 1 MB come without content; the blob API serves them up to 100 MB.
  const blob = blobSchema.parse(
    await gh.request<unknown>('GET', `repos/${repo}/git/blobs/${parsed.data.sha}`),
  );
  return decode(blob.content);
}

import { z } from 'zod';
import type { GitHub } from './api.js';

const appSchema = z.object({ id: z.number().int().positive() });

/**
 * A GitHub App's numeric id, from its slug or bot login. A private App answers only an
 * authenticated request: a person's token or an installation token.
 */
export async function appId(gh: GitHub, login: string): Promise<number> {
  const slug = login.replace(/\[bot\]$/, '');
  const raw = await gh.request<unknown>('GET', `apps/${encodeURIComponent(slug)}`);
  return appSchema.parse(raw).id;
}

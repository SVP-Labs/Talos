import { z } from 'zod';
import { EngineError } from '../core/check.js';

/** Node's `<process.platform>-<process.arch>` for each machine Talos runs on, or `any`. */
const PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'any',
] as const;

const inside = z
  .string()
  .min(1)
  .refine(
    (path) => !/^([/\\]|[a-z]:)/i.test(path) && !path.split(/[/\\]/).includes('..'),
    'must be a relative path that stays inside its directory',
  );

const download = z.strictObject({
  url: z.string().regex(/^(https|file):\/\/\S+$/, 'must be an https URL'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hexadecimal sha256'),
  /** The executable inside the archive; for a single file, the name it is saved under. */
  path: inside,
});

const fileTool = z.strictObject({
  version: z.string().min(1),
  /**
   * `archive`: a tar or zip, unpacked whole; `binary`: the download is the tool itself;
   * `psgallery`: a PowerShell Gallery package, a zip whose `path` is the module manifest.
   */
  kind: z.enum(['archive', 'binary', 'psgallery']),
  platforms: z
    .partialRecord(z.enum(PLATFORMS), download)
    .refine((platforms) => Object.keys(platforms).length > 0, 'must list at least one download'),
});

const pypiTool = z.strictObject({
  version: z.string().min(1),
  kind: z.literal('pypi'),
  /** Relative to `tools.lock`: requirements with a hash for every distribution. */
  requirements: inside,
  /** The console script the package installs. */
  bin: z.string().regex(/^[\w.-]+$/, 'must be a program name'),
});

const lockSchema = z.strictObject({
  '//': z.string().optional(),
  /** The interpreters Talos installs tools into; the runtime checks read them too. */
  runtimes: z.strictObject({
    python: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be an exact version'),
  }),
  tools: z.record(
    z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a lowercase name'),
    z.union([fileTool, pypiTool]),
  ),
});

export type ToolsLock = z.infer<typeof lockSchema>;
export type LockedTool = z.infer<typeof fileTool> | z.infer<typeof pypiTool>;
export type FileTool = z.infer<typeof fileTool>;
export type PypiTool = z.infer<typeof pypiTool>;
export type Download = z.infer<typeof download>;

/** Reads `tools.lock`; anything malformed is an engine error naming where. */
export function parseLock(text: string, where: string): ToolsLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EngineError(`${where} is not valid JSON`);
  }
  const parsed = lockSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue === undefined ? '' : issue.path.map(String).join('.');
    throw new EngineError(`${where} is invalid at ${at}: ${issue?.message ?? 'unknown problem'}`);
  }
  return parsed.data;
}

export function lockedTool(lock: ToolsLock, name: string): LockedTool {
  const tool = lock.tools[name];
  if (tool === undefined) throw new EngineError(`${name} is not in tools.lock`);
  return tool;
}

/** The download for this machine, or the one that serves every machine. */
export function downloadFor(tool: FileTool, name: string, platform: string): Download {
  const own = PLATFORMS.find((key) => key === platform);
  const chosen = (own === undefined ? undefined : tool.platforms[own]) ?? tool.platforms.any;
  if (chosen === undefined) {
    throw new EngineError(`tools.lock has no ${name} ${tool.version} for ${platform}`);
  }
  return chosen;
}

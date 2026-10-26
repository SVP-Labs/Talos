import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LUACHECK_BASE } from './configs.js';
import { parseLoadedConfig, weakerLuacheck } from './luacheck-config.js';
import { componentDir, inRepo, LUACHECK_PROJECT } from './paths.js';
import { type Bound, runScript } from './run.js';
import { LUACHECK_CONFIG_SCRIPT } from './scripts/luacheck.js';
import type { Finding, Location } from '../../core/finding.js';

/** The project file's whole span, so any change to it touches the findings it causes. */
async function projectSpan(ctx: Bound): Promise<Location | undefined> {
  const text = await readFile(join(componentDir(ctx), LUACHECK_PROJECT), 'utf8').catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).length;
  return {
    file: inRepo(ctx.component.root, LUACHECK_PROJECT),
    line: 1,
    endLine: Math.max(1, lines),
  };
}

/**
 * luacheck's configuration as luacheck loads it (the rendered base, which returns the project's
 * settings) against the base. StyLua and LuaLS run with files the project can't extend, and
 * inline comments are suppressions, which the suppressions check counts.
 */
export async function strength(ctx: Bound): Promise<Finding[]> {
  const loaded = parseLoadedConfig(await runScript(ctx, LUACHECK_CONFIG_SCRIPT, []));
  if (loaded === undefined) return [];
  const location = await projectSpan(ctx);
  const project = inRepo(ctx.component.root, LUACHECK_PROJECT);
  return weakerLuacheck(loaded).map((w) => ({
    rule: 'config/weaker',
    message: `${project} ${w.how}; it may only tighten ${LUACHECK_BASE}.`,
    key: `${project} ${w.setting}`,
    ...(location === undefined ? {} : { location }),
  }));
}

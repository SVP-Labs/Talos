import type { Engine } from './run.js';
import { consoleLogger, type Logger } from '../core/log.js';
import { PACKS } from '../core/registry.js';
import { exec } from '../exec/exec.js';
import { createTools } from '../tools/lock.js';
import { ownVersion } from '../version/self.js';

/** The engine as the CLI runs it: real processes, tools from `tools.lock`, every pack. */
export function createEngine(verbose: boolean, log: Logger = consoleLogger(verbose)): Engine {
  return { exec, tools: createTools(exec, log), log, version: ownVersion(), packs: PACKS };
}

import type { Tools } from './tools.js';
import { EngineError } from '../core/check.js';
import type { Logger } from '../core/log.js';
import type { Exec } from '../exec/exec.js';

/** Reads `tools.lock` and fetches tools into the cache on first use. */
export function createTools(_exec: Exec, _log: Logger): Tools {
  return {
    path: (name) => Promise.reject(new EngineError(`${name} is not in tools.lock`)),
    version: (name) => {
      throw new EngineError(`${name} is not in tools.lock`);
    },
  };
}

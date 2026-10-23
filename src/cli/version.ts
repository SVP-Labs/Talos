import type { Command } from './io.js';
import { ownVersion } from '../version/self.js';

export const version: Command = (_argv, io) => {
  io.out(`${ownVersion()}\n`);
  return Promise.resolve(0);
};

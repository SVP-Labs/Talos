import { type Command, UsageError } from './io.js';

export const org: Command = () => Promise.reject(new UsageError('not built yet'));

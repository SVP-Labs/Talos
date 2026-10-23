import { type Command, UsageError } from './io.js';

export const configs: Command = () => Promise.reject(new UsageError('not built yet'));

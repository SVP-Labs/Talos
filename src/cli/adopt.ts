import { type Command, UsageError } from './io.js';

export const adopt: Command = () => Promise.reject(new UsageError('not built yet'));

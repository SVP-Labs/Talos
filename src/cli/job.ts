import { type Command, UsageError } from './io.js';

export const job: Command = () => Promise.reject(new UsageError('not built yet'));

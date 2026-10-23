import { type Command, UsageError } from './io.js';

export const ticket: Command = () => Promise.reject(new UsageError('not built yet'));

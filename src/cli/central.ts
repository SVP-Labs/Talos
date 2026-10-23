import { type Command, UsageError } from './io.js';

export const central: Command = () => Promise.reject(new UsageError('not built yet'));

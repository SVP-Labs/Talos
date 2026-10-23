import { type Command, UsageError } from './io.js';

export const doctor: Command = () => Promise.reject(new UsageError('not built yet'));

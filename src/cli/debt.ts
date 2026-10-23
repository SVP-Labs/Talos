import { type Command, UsageError } from './io.js';

export const debt: Command = () => Promise.reject(new UsageError('not built yet'));

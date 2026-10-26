export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
};

export function consoleLogger(verbose: boolean): Logger {
  return {
    info: (message) => {
      process.stderr.write(`${message}\n`);
    },
    warn: (message) => {
      process.stderr.write(`warning: ${message}\n`);
    },
    debug: (message) => {
      if (verbose) process.stderr.write(`· ${message}\n`);
    },
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

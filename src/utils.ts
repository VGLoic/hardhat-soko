export function toAsyncResult<T, TError = Error>(
  promise: Promise<T>,
  opts: {
    debug?: boolean;
  } = {},
): Promise<{ success: true; value: T } | { success: false; error: TError }> {
  return promise
    .then((value) => ({ success: true as const, value }))
    .catch((error) => {
      if (opts.debug) {
        console.error(error);
      }
      return { success: false as const, error };
    });
}

export function completeMessage(message: string, opts: { debug: boolean }) {
  return `Soko: ${message}${opts.debug ? "" : "\nFor more information, please run the same command with the `debug: true` option in Soko part of Hardhat configuration."}`;
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const LOG_COLORS = {
  log: "\x1b[0m%s\x1b[0m",
  success: "\x1b[32m%s\x1b[0m",
  error: "\x1b[31m%s\x1b[0m",
  warn: "\x1b[33m%s\x1b[0m",
};

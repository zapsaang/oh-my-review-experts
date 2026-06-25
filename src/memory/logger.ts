export interface OmreLogger {
  log?: (...values: unknown[]) => void;
  warn?: (...values: unknown[]) => void;
  error?: (...values: unknown[]) => void;
}

export interface ResolvedOmreLogger {
  log: (...values: unknown[]) => void;
  warn: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
}

export const silentLogger: ResolvedOmreLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

export function resolveLogger(logger?: OmreLogger): ResolvedOmreLogger {
  return {
    log: (...values) => logger?.log?.(...values),
    warn: (...values) => logger?.warn?.(...values),
    error: (...values) => logger?.error?.(...values),
  };
}

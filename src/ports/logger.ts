/**
 * LoggerPort — structured logger interface.
 *
 * Shape matches Pino's child-logger subset. Host wires any concrete
 * logger (pino, winston, console-shim) that implements these methods.
 */
export interface LoggerPort {
  debug(objOrMsg: object | string, msg?: string): void;
  info(objOrMsg: object | string, msg?: string): void;
  warn(objOrMsg: object | string, msg?: string): void;
  error(objOrMsg: object | string, msg?: string): void;
  child?(bindings: Record<string, unknown>): LoggerPort;
}

/**
 * noopLogger — convenience for tests where logs are not asserted.
 */
export const noopLogger: LoggerPort = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

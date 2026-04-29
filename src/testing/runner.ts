/**
 * Runner-agnostic shape for injecting describe/it/expect.
 *
 * The three functions match the subset used by vitest, jest, mocha,
 * bun:test — so any host can plug in their test framework without
 * dragging agent-sdk into a specific one.
 */

export interface ConformanceRunner<E = unknown> {
  /** describe block (sync fn). */
  describe(name: string, body: () => void): void;
  /** it block (async fn allowed). */
  it(name: string, body: () => void | Promise<void>): void;
  /**
   * expect(actual) — returns a chainable matcher. Shape is a superset
   * of Jest/Vitest's `expect`. Callers pass vitest/jest's expect directly.
   */
  expect: E;
}

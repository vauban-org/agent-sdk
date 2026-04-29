/**
 * LoggerPort conformance suite.
 *
 * Contract: debug/info/warn/error accept either (object, optional string)
 * or (string) without throwing. Returns void. Sync.
 */

import type { LoggerPort } from "../ports/logger.js";
import type { ConformanceRunner } from "./runner.js";

export interface LoggerConformanceConfig {
  describe: ConformanceRunner["describe"];
  it: ConformanceRunner["it"];
  // biome-ignore lint/suspicious/noExplicitAny: matcher shape
  expect: any;
  factory: () => Promise<LoggerPort> | LoggerPort;
}

export function loggerPortConformance(config: LoggerConformanceConfig): void {
  const { describe, it, expect, factory } = config;

  describe("LoggerPort conformance", () => {
    it("all four levels accept (string)", async () => {
      const logger = await factory();
      expect(() => logger.debug("hello")).not.toThrow();
      expect(() => logger.info("hello")).not.toThrow();
      expect(() => logger.warn("hello")).not.toThrow();
      expect(() => logger.error("hello")).not.toThrow();
    });

    it("all four levels accept (object)", async () => {
      const logger = await factory();
      const obj = { foo: 1, bar: "x" };
      expect(() => logger.debug(obj)).not.toThrow();
      expect(() => logger.info(obj)).not.toThrow();
      expect(() => logger.warn(obj)).not.toThrow();
      expect(() => logger.error(obj)).not.toThrow();
    });

    it("all four levels accept (object, msg)", async () => {
      const logger = await factory();
      const obj = { trace: "id" };
      expect(() => logger.debug(obj, "d")).not.toThrow();
      expect(() => logger.info(obj, "i")).not.toThrow();
      expect(() => logger.warn(obj, "w")).not.toThrow();
      expect(() => logger.error(obj, "e")).not.toThrow();
    });

    it("child (optional) returns a LoggerPort", async () => {
      const logger = await factory();
      if (!logger.child) return;
      const child = logger.child({ bound: "context" });
      expect(typeof child.info).toBe("function");
      expect(() => child.info("from child")).not.toThrow();
    });
  });
}

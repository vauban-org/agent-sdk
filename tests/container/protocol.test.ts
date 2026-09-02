import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROTOCOL_MODE,
  PROTOCOL_ENV,
  ProtocolParseError,
  buildProtocolEnv,
  parseProtocolOutput,
  parseStderrLogs,
} from "../../src/container/protocol.js";

describe("buildProtocolEnv", () => {
  it("sets all 5 reserved keys with correct types", () => {
    const env = buildProtocolEnv({
      executionId: "exec-1",
      automationName: "echo",
      input: { foo: 42 },
      timeoutSeconds: 60,
    });
    expect(env[PROTOCOL_ENV.EXECUTION_ID]).toBe("exec-1");
    expect(env[PROTOCOL_ENV.AUTOMATION_NAME]).toBe("echo");
    expect(env[PROTOCOL_ENV.INPUT]).toBe('{"foo":42}');
    expect(env[PROTOCOL_ENV.TIMEOUT]).toBe("60");
    expect(env[PROTOCOL_ENV.MODE]).toBe(DEFAULT_PROTOCOL_MODE);
  });

  it("uses caller-provided mode when set", () => {
    const env = buildProtocolEnv({
      executionId: "exec-2",
      automationName: "x",
      input: null,
      timeoutSeconds: 1,
      mode: "schema",
    });
    expect(env[PROTOCOL_ENV.MODE]).toBe("schema");
  });

  it("merges extraEnv but never lets it override reserved keys", () => {
    const env = buildProtocolEnv({
      executionId: "exec-3",
      automationName: "x",
      input: 1,
      timeoutSeconds: 30,
      extraEnv: {
        FOO: "bar",
        [PROTOCOL_ENV.EXECUTION_ID]: "ATTEMPTED-OVERRIDE",
      },
    });
    expect(env.FOO).toBe("bar");
    expect(env[PROTOCOL_ENV.EXECUTION_ID]).toBe("exec-3");
  });

  it("serializes complex inputs as JSON", () => {
    const env = buildProtocolEnv({
      executionId: "x",
      automationName: "x",
      input: { list: [1, 2, 3], nested: { a: true } },
      timeoutSeconds: 5,
    });
    expect(JSON.parse(env[PROTOCOL_ENV.INPUT]!)).toEqual({
      list: [1, 2, 3],
      nested: { a: true },
    });
  });
});

describe("parseProtocolOutput", () => {
  it("returns completed when stdout's last line is a completed protocol JSON", () => {
    const result = parseProtocolOutput<{ result: number }>(
      'some chatty preamble\n{"status":"completed","output":{"result":42}}',
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ result: 42 });
    }
  });

  it("returns failed with full error payload when status=failed", () => {
    const result = parseProtocolOutput(
      '{"status":"failed","error":{"code":"BAD_INPUT","message":"x","details":{"k":1}}}',
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("BAD_INPUT");
      expect(result.error.message).toBe("x");
      expect(result.error.details).toEqual({ k: 1 });
    }
  });

  it("provides defaults for missing error fields", () => {
    const result = parseProtocolOutput('{"status":"failed"}');
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("UNKNOWN");
      expect(result.error.message).toBe("(no message)");
    }
  });

  it("ignores trailing whitespace lines and uses the last non-empty line", () => {
    const result = parseProtocolOutput('log\n{"status":"completed","output":null}\n   \n');
    expect(result.status).toBe("completed");
  });

  it("throws ProtocolParseError on empty stdout", () => {
    expect(() => parseProtocolOutput("")).toThrow(ProtocolParseError);
    expect(() => parseProtocolOutput("   \n\n")).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError on non-JSON tail", () => {
    expect(() => parseProtocolOutput("not json at all")).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError on JSON without status field", () => {
    expect(() => parseProtocolOutput('{"foo":1}')).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError on unknown status value", () => {
    expect(() => parseProtocolOutput('{"status":"banana"}')).toThrow(ProtocolParseError);
  });
});

describe("parseStderrLogs", () => {
  it("parses one JSON log object per line", () => {
    const stderr =
      '{"level":"info","message":"a","timestamp":"2026-05-15T00:00:00Z"}\n' +
      '{"level":"warn","message":"b","timestamp":"2026-05-15T00:00:01Z"}';
    const logs = parseStderrLogs(stderr);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ level: "info", message: "a" });
    expect(logs[1]).toMatchObject({ level: "warn", message: "b" });
  });

  it("falls back to info+plain text on non-JSON lines", () => {
    const logs = parseStderrLogs('plain line\n{"level":"error","message":"x"}');
    expect(logs).toHaveLength(2);
    expect(logs[0]?.level).toBe("info");
    expect(logs[0]?.message).toBe("plain line");
    expect(logs[1]?.level).toBe("error");
  });

  it("skips empty lines", () => {
    expect(parseStderrLogs("")).toEqual([]);
    expect(parseStderrLogs("\n\n   \n")).toEqual([]);
  });
});

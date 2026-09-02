/**
 * Tests for packages/agent-sdk/src/container/protocol.ts
 *
 * Coverage:
 *   PROTOCOL_ENV      — constant shape and values
 *   DEFAULT_PROTOCOL_MODE — value
 *   ProtocolParseError — constructor, name, rawTail, instanceof, message prefix
 *   buildProtocolEnv  — all fields, mode default/override, extraEnv merge,
 *                       extraEnv cannot override reserved keys, various input types
 *   parseProtocolOutput — completed/failed happy paths, defaults for missing
 *                         error fields, multi-line stdout, trailing whitespace,
 *                         empty stdout, non-JSON tail, missing status, unknown status,
 *                         null/array/primitive JSON at last line
 *   parseStderrLogs   — JSON logs, plain text fallback, empty input,
 *                       missing level/message/timestamp defaults, mixed lines,
 *                       lines longer than 500 chars get truncated
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROTOCOL_MODE,
  type ExecutionResult,
  PROTOCOL_ENV,
  ProtocolParseError,
  type ProtocolResult,
  buildProtocolEnv,
  parseProtocolOutput,
  parseStderrLogs,
} from "../src/container/protocol.js";

// ─── PROTOCOL_ENV ─────────────────────────────────────────────────────────────

describe("PROTOCOL_ENV", () => {
  it("has exactly 5 keys", () => {
    expect(Object.keys(PROTOCOL_ENV)).toHaveLength(5);
  });

  it("EXECUTION_ID equals VAUBAN_EXECUTION_ID", () => {
    expect(PROTOCOL_ENV.EXECUTION_ID).toBe("VAUBAN_EXECUTION_ID");
  });

  it("AUTOMATION_NAME equals VAUBAN_AUTOMATION_NAME", () => {
    expect(PROTOCOL_ENV.AUTOMATION_NAME).toBe("VAUBAN_AUTOMATION_NAME");
  });

  it("INPUT equals VAUBAN_INPUT", () => {
    expect(PROTOCOL_ENV.INPUT).toBe("VAUBAN_INPUT");
  });

  it("TIMEOUT equals VAUBAN_TIMEOUT", () => {
    expect(PROTOCOL_ENV.TIMEOUT).toBe("VAUBAN_TIMEOUT");
  });

  it("MODE equals VAUBAN_MODE", () => {
    expect(PROTOCOL_ENV.MODE).toBe("VAUBAN_MODE");
  });

  it("all values are strings starting with VAUBAN_", () => {
    for (const v of Object.values(PROTOCOL_ENV)) {
      expect(typeof v).toBe("string");
      expect(v).toMatch(/^VAUBAN_/);
    }
  });
});

// ─── DEFAULT_PROTOCOL_MODE ────────────────────────────────────────────────────

describe("DEFAULT_PROTOCOL_MODE", () => {
  it("is the string 'execute'", () => {
    expect(DEFAULT_PROTOCOL_MODE).toBe("execute");
  });
});

// ─── ProtocolParseError ───────────────────────────────────────────────────────

describe("ProtocolParseError", () => {
  it("is an instance of Error", () => {
    const e = new ProtocolParseError("reason", "tail");
    expect(e).toBeInstanceOf(Error);
  });

  it("is an instance of ProtocolParseError", () => {
    const e = new ProtocolParseError("reason", "tail");
    expect(e).toBeInstanceOf(ProtocolParseError);
  });

  it("has name ProtocolParseError", () => {
    expect(new ProtocolParseError("r", "t").name).toBe("ProtocolParseError");
  });

  it("message is prefixed with 'container-protocol:'", () => {
    const e = new ProtocolParseError("something went wrong", "raw");
    expect(e.message).toBe("container-protocol: something went wrong");
  });

  it("stores rawTail verbatim", () => {
    const e = new ProtocolParseError("x", "my raw tail");
    expect(e.rawTail).toBe("my raw tail");
  });

  it("rawTail can be an empty string", () => {
    const e = new ProtocolParseError("empty tail", "");
    expect(e.rawTail).toBe("");
  });
});

// ─── buildProtocolEnv ────────────────────────────────────────────────────────

describe("buildProtocolEnv", () => {
  it("sets all 5 reserved protocol keys", () => {
    const env = buildProtocolEnv({
      executionId: "exec-abc",
      automationName: "my-automation",
      input: { x: 1 },
      timeoutSeconds: 30,
    });
    for (const key of Object.values(PROTOCOL_ENV)) {
      expect(env[key]).toBeDefined();
    }
  });

  it("uses DEFAULT_PROTOCOL_MODE when mode is not supplied", () => {
    const env = buildProtocolEnv({
      executionId: "e1",
      automationName: "a",
      input: null,
      timeoutSeconds: 10,
    });
    expect(env[PROTOCOL_ENV.MODE]).toBe(DEFAULT_PROTOCOL_MODE);
  });

  it("uses caller-supplied mode when provided", () => {
    const env = buildProtocolEnv({
      executionId: "e2",
      automationName: "a",
      input: null,
      timeoutSeconds: 10,
      mode: "schema",
    });
    expect(env[PROTOCOL_ENV.MODE]).toBe("schema");
  });

  it("TIMEOUT is stringified correctly", () => {
    const env = buildProtocolEnv({
      executionId: "e",
      automationName: "a",
      input: 0,
      timeoutSeconds: 120,
    });
    expect(env[PROTOCOL_ENV.TIMEOUT]).toBe("120");
  });

  it("serializes null input as JSON string 'null'", () => {
    const env = buildProtocolEnv({
      executionId: "e",
      automationName: "a",
      input: null,
      timeoutSeconds: 5,
    });
    expect(env[PROTOCOL_ENV.INPUT]).toBe("null");
  });

  it("serializes array input as JSON", () => {
    const env = buildProtocolEnv({
      executionId: "e",
      automationName: "a",
      input: [1, 2, 3],
      timeoutSeconds: 5,
    });
    expect(JSON.parse(env[PROTOCOL_ENV.INPUT]!)).toEqual([1, 2, 3]);
  });

  it("serializes boolean input as JSON", () => {
    const env = buildProtocolEnv({
      executionId: "e",
      automationName: "a",
      input: true,
      timeoutSeconds: 5,
    });
    expect(env[PROTOCOL_ENV.INPUT]).toBe("true");
  });

  it("merges extraEnv keys into result", () => {
    const env = buildProtocolEnv({
      executionId: "e",
      automationName: "a",
      input: {},
      timeoutSeconds: 1,
      extraEnv: { MY_KEY: "my_val", ANOTHER: "123" },
    });
    expect(env.MY_KEY).toBe("my_val");
    expect(env.ANOTHER).toBe("123");
  });

  it("reserved keys override any extraEnv attempt to shadow them", () => {
    const env = buildProtocolEnv({
      executionId: "real-id",
      automationName: "real-name",
      input: {},
      timeoutSeconds: 1,
      extraEnv: {
        [PROTOCOL_ENV.EXECUTION_ID]: "shadow",
        [PROTOCOL_ENV.AUTOMATION_NAME]: "shadow",
        [PROTOCOL_ENV.INPUT]: "shadow",
        [PROTOCOL_ENV.TIMEOUT]: "shadow",
        [PROTOCOL_ENV.MODE]: "shadow",
      },
    });
    expect(env[PROTOCOL_ENV.EXECUTION_ID]).toBe("real-id");
    expect(env[PROTOCOL_ENV.AUTOMATION_NAME]).toBe("real-name");
    expect(env[PROTOCOL_ENV.INPUT]).toBe("{}");
    expect(env[PROTOCOL_ENV.TIMEOUT]).toBe("1");
    expect(env[PROTOCOL_ENV.MODE]).toBe(DEFAULT_PROTOCOL_MODE);
  });

  it("returns a plain object (no prototype oddities)", () => {
    const env = buildProtocolEnv({
      executionId: "e",
      automationName: "a",
      input: 0,
      timeoutSeconds: 1,
    });
    expect(typeof env).toBe("object");
    expect(env).not.toBeNull();
  });

  it("works without extraEnv property at all", () => {
    expect(() =>
      buildProtocolEnv({
        executionId: "e",
        automationName: "a",
        input: {},
        timeoutSeconds: 5,
      }),
    ).not.toThrow();
  });
});

// ─── parseProtocolOutput ──────────────────────────────────────────────────────

describe("parseProtocolOutput — completed", () => {
  it("parses a single-line completed result", () => {
    const r = parseProtocolOutput<number>('{"status":"completed","output":99}');
    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      expect(r.output).toBe(99);
    }
  });

  it("parses a multi-line stdout; only the last line matters", () => {
    const r = parseProtocolOutput(
      "Initializing…\nRunning step 1\n" + '{"status":"completed","output":{"value":"ok"}}',
    );
    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      expect((r.output as { value: string }).value).toBe("ok");
    }
  });

  it("output can be null", () => {
    const r = parseProtocolOutput('{"status":"completed","output":null}');
    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      expect(r.output).toBeNull();
    }
  });

  it("output defaults to null when key is absent", () => {
    const r = parseProtocolOutput('{"status":"completed"}');
    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      expect(r.output).toBeNull();
    }
  });

  it("ignores trailing whitespace-only lines", () => {
    const r = parseProtocolOutput('{"status":"completed","output":1}\n   \n\t\n');
    expect(r.status).toBe("completed");
  });
});

describe("parseProtocolOutput — failed", () => {
  it("parses a fully specified failed result", () => {
    const r = parseProtocolOutput(
      '{"status":"failed","error":{"code":"TIMEOUT","message":"too slow","details":42}}',
    );
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error.code).toBe("TIMEOUT");
      expect(r.error.message).toBe("too slow");
      expect(r.error.details).toBe(42);
    }
  });

  it("defaults code to UNKNOWN when missing", () => {
    const r = parseProtocolOutput('{"status":"failed","error":{"message":"x"}}');
    if (r.status === "failed") {
      expect(r.error.code).toBe("UNKNOWN");
    }
  });

  it("defaults message to '(no message)' when missing", () => {
    const r = parseProtocolOutput('{"status":"failed","error":{"code":"E"}}');
    if (r.status === "failed") {
      expect(r.error.message).toBe("(no message)");
    }
  });

  it("handles completely absent error object with both defaults", () => {
    const r = parseProtocolOutput('{"status":"failed"}');
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error.code).toBe("UNKNOWN");
      expect(r.error.message).toBe("(no message)");
    }
  });

  it("details is undefined when not provided", () => {
    const r = parseProtocolOutput('{"status":"failed","error":{"code":"E","message":"m"}}');
    if (r.status === "failed") {
      expect(r.error.details).toBeUndefined();
    }
  });
});

describe("parseProtocolOutput — errors (ProtocolParseError)", () => {
  it("throws ProtocolParseError on fully empty string", () => {
    expect(() => parseProtocolOutput("")).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError on whitespace-only string", () => {
    expect(() => parseProtocolOutput("   \n\n\t  ")).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError when last line is not JSON", () => {
    expect(() => parseProtocolOutput("log\nnot json")).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError when JSON has no status field", () => {
    expect(() => parseProtocolOutput('{"code":"OK"}')).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError on unknown status value", () => {
    expect(() => parseProtocolOutput('{"status":"pending"}')).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError when last-line JSON is an array", () => {
    expect(() => parseProtocolOutput("[1,2,3]")).toThrow(ProtocolParseError);
  });

  it("throws ProtocolParseError when last-line JSON is a primitive null", () => {
    expect(() => parseProtocolOutput("null")).toThrow(ProtocolParseError);
  });

  it("error message is prefixed with 'container-protocol:'", () => {
    try {
      parseProtocolOutput("");
    } catch (e) {
      expect((e as Error).message).toMatch(/^container-protocol:/);
    }
  });

  it("rawTail is populated on parse failure", () => {
    try {
      parseProtocolOutput("not-json-here");
    } catch (e) {
      expect((e as ProtocolParseError).rawTail).toBe("not-json-here");
    }
  });
});

// ─── parseStderrLogs ─────────────────────────────────────────────────────────

describe("parseStderrLogs", () => {
  it("returns empty array for empty string", () => {
    expect(parseStderrLogs("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseStderrLogs("  \n  \n")).toEqual([]);
  });

  it("parses a single JSON log line", () => {
    const logs = parseStderrLogs(
      '{"level":"warn","message":"disk low","timestamp":"2026-01-01T00:00:00Z"}',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "warn",
      message: "disk low",
      timestamp: "2026-01-01T00:00:00Z",
    });
  });

  it("parses multiple JSON log lines in order", () => {
    const stderr =
      '{"level":"info","message":"start","timestamp":"T1"}\n' +
      '{"level":"error","message":"fail","timestamp":"T2"}';
    const logs = parseStderrLogs(stderr);
    expect(logs).toHaveLength(2);
    expect(logs[0]?.level).toBe("info");
    expect(logs[1]?.level).toBe("error");
  });

  it("wraps plain text lines as level=info", () => {
    const logs = parseStderrLogs("just a plain line");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("info");
    expect(logs[0]?.message).toBe("just a plain line");
  });

  it("plain text entries have a timestamp string", () => {
    const logs = parseStderrLogs("hello");
    expect(typeof logs[0]?.timestamp).toBe("string");
    expect(logs[0]?.timestamp.length).toBeGreaterThan(0);
  });

  it("defaults level to 'info' when JSON log has no level field", () => {
    const logs = parseStderrLogs('{"message":"no level","timestamp":"2026-01-01T00:00:00Z"}');
    expect(logs[0]?.level).toBe("info");
  });

  it("defaults message to the raw line when JSON log has no message field", () => {
    const raw = '{"level":"debug","timestamp":"T"}';
    const logs = parseStderrLogs(raw);
    expect(logs[0]?.message).toBe(raw);
  });

  it("defaults timestamp to current ISO string when JSON log has no timestamp field", () => {
    const before = new Date().toISOString();
    const logs = parseStderrLogs('{"level":"info","message":"x"}');
    const after = new Date().toISOString();
    const ts = logs[0]?.timestamp ?? "";
    expect(ts >= before || ts <= after).toBe(true);
  });

  it("skips blank lines between valid log lines", () => {
    const stderr =
      '{"level":"info","message":"a","timestamp":"T1"}\n\n\n' +
      '{"level":"info","message":"b","timestamp":"T2"}';
    const logs = parseStderrLogs(stderr);
    expect(logs).toHaveLength(2);
  });

  it("handles mix of JSON and plain lines", () => {
    const stderr =
      "plain line one\n" +
      '{"level":"error","message":"oops","timestamp":"T"}\n' +
      "plain line two";
    const logs = parseStderrLogs(stderr);
    expect(logs).toHaveLength(3);
    expect(logs[0]?.level).toBe("info");
    expect(logs[1]?.level).toBe("error");
    expect(logs[2]?.level).toBe("info");
  });

  it("truncates plain text lines longer than 500 chars to 500 chars", () => {
    const long = "x".repeat(600);
    const logs = parseStderrLogs(long);
    expect(logs[0]?.message.length).toBe(500);
  });
});

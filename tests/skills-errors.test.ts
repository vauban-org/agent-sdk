/**
 * Tests for src/skills/errors.ts
 *
 * Coverage:
 *   SkillNotConfiguredError — .name, .skillName, .missingEnv, message lists env vars
 *   SkillExecutionError — .name, .skillName, .status (optional), .cause (optional)
 *   SqlReadOnlyViolation — .name, .query, fixed message
 *   HttpFetchAllowlistError — .name, .url, .host, message contains host
 *   SkillMdParseError — .name, .filePath, message contains filePath and reason
 *   SkillMdValidationError — .name, .filePath, .issues, message summarizes issues
 *
 * Ref: test coverage for src/skills/errors.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import {
  HttpFetchAllowlistError,
  SkillExecutionError,
  SkillMdParseError,
  SkillMdValidationError,
  SkillNotConfiguredError,
  SqlReadOnlyViolation,
} from "../src/skills/errors.js";

// ─── SkillNotConfiguredError ──────────────────────────────────────────────────

describe("SkillNotConfiguredError", () => {
  it(".name is 'SkillNotConfiguredError'", () => {
    expect(new SkillNotConfiguredError("web-search", ["BRAVE_API_KEY"]).name).toBe(
      "SkillNotConfiguredError",
    );
  });

  it("stores skillName and missingEnv", () => {
    const err = new SkillNotConfiguredError("slack-notify", ["SLACK_WEBHOOK"]);
    expect(err.skillName).toBe("slack-notify");
    expect(err.missingEnv).toEqual(["SLACK_WEBHOOK"]);
  });

  it("message lists all missing env vars", () => {
    const err = new SkillNotConfiguredError("smtp", ["SMTP_HOST", "SMTP_PASS"]);
    expect(err.message).toContain("SMTP_HOST");
    expect(err.message).toContain("SMTP_PASS");
  });

  it("instanceof Error and SkillNotConfiguredError", () => {
    const err = new SkillNotConfiguredError("x", []);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SkillNotConfiguredError);
  });
});

// ─── SkillExecutionError ─────────────────────────────────────────────────────

describe("SkillExecutionError", () => {
  it(".name is 'SkillExecutionError'", () => {
    expect(new SkillExecutionError("alpaca", "timeout").name).toBe("SkillExecutionError");
  });

  it("stores skillName", () => {
    expect(new SkillExecutionError("cboe-vix", "rate limited").skillName).toBe("cboe-vix");
  });

  it("stores status when provided", () => {
    const err = new SkillExecutionError("web-search", "upstream", {
      status: 429,
    });
    expect(err.status).toBe(429);
  });

  it("status is undefined when not provided", () => {
    expect(new SkillExecutionError("x", "msg").status).toBeUndefined();
  });

  it("stores cause when provided", () => {
    const cause = new Error("upstream");
    const err = new SkillExecutionError("x", "msg", { cause });
    expect(err.cause).toBe(cause);
  });

  it("message contains skillName and the error message", () => {
    const err = new SkillExecutionError("starknet", "RPC timeout");
    expect(err.message).toContain("starknet");
    expect(err.message).toContain("RPC timeout");
  });
});

// ─── SqlReadOnlyViolation ─────────────────────────────────────────────────────

describe("SqlReadOnlyViolation", () => {
  it(".name is 'SqlReadOnlyViolation'", () => {
    expect(new SqlReadOnlyViolation("DELETE FROM users").name).toBe("SqlReadOnlyViolation");
  });

  it("stores the query", () => {
    const q = "DROP TABLE users";
    expect(new SqlReadOnlyViolation(q).query).toBe(q);
  });

  it("message mentions read-only scope", () => {
    const err = new SqlReadOnlyViolation("DELETE FROM x");
    expect(err.message).toContain("read");
  });
});

// ─── HttpFetchAllowlistError ──────────────────────────────────────────────────

describe("HttpFetchAllowlistError", () => {
  it(".name is 'HttpFetchAllowlistError'", () => {
    expect(new HttpFetchAllowlistError("https://evil.com/api", "evil.com").name).toBe(
      "HttpFetchAllowlistError",
    );
  });

  it("stores url and host", () => {
    const err = new HttpFetchAllowlistError("https://evil.com/path", "evil.com");
    expect(err.url).toBe("https://evil.com/path");
    expect(err.host).toBe("evil.com");
  });

  it("message contains the blocked host", () => {
    const err = new HttpFetchAllowlistError("https://evil.com/path", "evil.com");
    expect(err.message).toContain("evil.com");
  });
});

// ─── SkillMdParseError ────────────────────────────────────────────────────────

describe("SkillMdParseError", () => {
  it(".name is 'SkillMdParseError'", () => {
    expect(new SkillMdParseError("/path/skill.md", "missing frontmatter").name).toBe(
      "SkillMdParseError",
    );
  });

  it("stores filePath", () => {
    expect(new SkillMdParseError("/skills/foo.md", "x").filePath).toBe("/skills/foo.md");
  });

  it("message includes filePath and reason", () => {
    const err = new SkillMdParseError("/skills/foo.md", "unexpected token");
    expect(err.message).toContain("/skills/foo.md");
    expect(err.message).toContain("unexpected token");
  });
});

// ─── SkillMdValidationError ───────────────────────────────────────────────────

describe("SkillMdValidationError", () => {
  it(".name is 'SkillMdValidationError'", () => {
    expect(new SkillMdValidationError("/skills/x.md", []).name).toBe("SkillMdValidationError");
  });

  it("stores filePath and issues", () => {
    const issues = [{ path: "name", message: "required" }];
    const err = new SkillMdValidationError("/skills/x.md", issues);
    expect(err.filePath).toBe("/skills/x.md");
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0].path).toBe("name");
  });

  it("message summarizes all issues", () => {
    const err = new SkillMdValidationError("/skills/x.md", [
      { path: "name", message: "too short" },
      { path: "description", message: "required" },
    ]);
    expect(err.message).toContain("too short");
    expect(err.message).toContain("required");
  });

  it("uses (root) for issues with empty path", () => {
    const err = new SkillMdValidationError("/skills/x.md", [
      { path: "", message: "invalid frontmatter" },
    ]);
    expect(err.message).toContain("(root)");
  });
});

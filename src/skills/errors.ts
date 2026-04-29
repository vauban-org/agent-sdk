/**
 * Skill-specific error classes.
 *
 * Each external service (Brave/Tavily, Alpaca, Telegram, Slack, SMTP/Resend,
 * CBOE, Starknet) throws a `<Skill>NotConfiguredError` when required env keys
 * are missing — distinguishes "config gap" from "live API failure".
 *
 * @public
 */

export class SkillNotConfiguredError extends Error {
  readonly skillName: string;
  readonly missingEnv: readonly string[];
  constructor(skillName: string, missingEnv: readonly string[]) {
    super(
      `Skill '${skillName}' not configured: missing env ${missingEnv.join(", ")}`,
    );
    this.name = "SkillNotConfiguredError";
    this.skillName = skillName;
    this.missingEnv = missingEnv;
  }
}

export class SkillExecutionError extends Error {
  readonly skillName: string;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(
    skillName: string,
    message: string,
    opts?: { status?: number; cause?: unknown },
  ) {
    super(`Skill '${skillName}' failed: ${message}`);
    this.name = "SkillExecutionError";
    this.skillName = skillName;
    this.status = opts?.status;
    this.cause = opts?.cause;
  }
}

export class SqlReadOnlyViolation extends Error {
  readonly query: string;
  constructor(query: string) {
    super("SQL skill rejected non-read query (cc:read scope)");
    this.name = "SqlReadOnlyViolation";
    this.query = query;
  }
}

export class HttpFetchAllowlistError extends Error {
  readonly url: string;
  readonly host: string;
  constructor(url: string, host: string) {
    super(`http_fetch: host '${host}' not in HTTP_FETCH_ALLOWLIST`);
    this.name = "HttpFetchAllowlistError";
    this.url = url;
    this.host = host;
  }
}

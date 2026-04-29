/**
 * Skill Catalog — 13 builtin OODA skills + record_outcome helper.
 *
 * Each skill is a pure function with a strict Zod input schema, typed output,
 * and `isReplay` enforcement (V8-2 critical for sprint-530 replay engine).
 * OTEL instrumentation is wired automatically when env
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 * Differentiator vs Hermes 118 skills: each call emits a run_step with
 * `leaf_hash_poseidon` so audits can prove "agent X called skill Y with
 * input Z at time T".
 *
 * @public
 */

export {
  SkillNotConfiguredError,
  SkillExecutionError,
  SqlReadOnlyViolation,
  HttpFetchAllowlistError,
} from "./errors.js";

export { webSearch } from "./web-search.js";
export type { WebSearchOutput, WebSearchResult } from "./web-search.js";

export { alpacaQuote } from "./alpaca-quote.js";
export type { AlpacaQuoteOutput } from "./alpaca-quote.js";

export { brainStore } from "./brain-store.js";
export type { BrainStoreOutput } from "./brain-store.js";

export { brainQuery } from "./brain-query.js";
export type { BrainQueryOutput } from "./brain-query.js";

export { telegramNotify } from "./telegram-notify.js";
export type { TelegramNotifyOutput } from "./telegram-notify.js";

export { slackNotify } from "./slack-notify.js";
export type { SlackNotifyOutput } from "./slack-notify.js";

export { sendEmail } from "./send-email.js";
export type { SendEmailOutput } from "./send-email.js";

export { runSqlQuery, isReadOnlySql } from "./run-sql-query.js";
export type { RunSqlQueryOutput } from "./run-sql-query.js";

export { cboeVixSpot, _clearCboeVixCache } from "./cboe-vix-spot.js";
export type { CboeVixSpotOutput } from "./cboe-vix-spot.js";

export { starknetBalance } from "./starknet-balance.js";
export type { StarknetBalanceOutput } from "./starknet-balance.js";

export { calendarCheck, _resetCalendarCache } from "./calendar-check.js";
export type { CalendarCheckOutput } from "./calendar-check.js";

export { hitlRequest } from "./hitl-request.js";
export type { HitlRequestOutput } from "./hitl-request.js";

export { httpFetch, isHostAllowed } from "./http-fetch.js";
export type { HttpFetchOutput } from "./http-fetch.js";

export { recordOutcomeSkill, _resetOutcomesIndex } from "./record-outcome.js";
export type { RecordOutcomeOutput } from "./record-outcome.js";

// Skill Ledger types + resolver (SDK v0.8.0 — sprint-530:quick-4)
export { resolveSkillsForAgent } from "./skill-ledger.js";
export type {
  SkillLedgerEntry,
  SkillLifecycleState,
  ResolveSkillsOptions,
} from "./skill-ledger.js";

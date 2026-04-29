/**
 * Shared test helpers for skill tests.
 */
import { vi } from "vitest";
import type {
  Skill,
  SkillContext,
} from "../src/orchestration/ooda/skills.js";
import { noopLogger } from "../src/ports/logger.js";

export interface MockDbBuilder {
  query: ReturnType<typeof vi.fn>;
}

export function makeMockDb(rows: unknown[] = []): MockDbBuilder {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

export function makeCtx(opts: {
  isReplay?: boolean;
  rows?: unknown[];
  brain?: { archiveKnowledge?: ReturnType<typeof vi.fn>; queryKnowledge?: ReturnType<typeof vi.fn> };
  dryRunMocks?: Record<string, (input: unknown) => unknown>;
} = {}): SkillContext & { brain?: unknown } {
  const db = makeMockDb(opts.rows);
  return {
    isReplay: opts.isReplay ?? false,
    dryRunMocks: opts.dryRunMocks ?? {},
    db: db as unknown as SkillContext["db"],
    logger: noopLogger,
    brain: opts.brain,
  };
}

export async function expectInputValidationError<I, O>(
  skill: Skill<I, O>,
  badInput: unknown,
): Promise<unknown> {
  try {
    skill.inputSchema.parse(badInput);
  } catch (err) {
    return err;
  }
  throw new Error("expected ZodError");
}

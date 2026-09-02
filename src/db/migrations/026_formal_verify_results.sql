-- 026_formal_verify_results.sql
--
-- Sprint-587 — Persistence for Z3 formal verification outcomes.
--
-- One row per (cycle_id, axiom) verification attempt. UNKNOWN and SKIPPED
-- are first-class states (NOT folded into SAFE/UNSAFE). The `mode` and
-- `context` columns preserve enough metadata to reproduce the decision
-- under a different policy without re-running the solver.

CREATE TABLE IF NOT EXISTS formal_verify_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id        TEXT NOT NULL,
  axiom           TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('SAFE','UNSAFE','UNKNOWN','SKIPPED')),
  rationale       TEXT,
  witness         TEXT,
  counterexample  TEXT,
  time_ms         INT,
  mode            TEXT NOT NULL DEFAULT 'permissive'
                  CHECK (mode IN ('strict','permissive','audit_only')),
  context         TEXT NOT NULL DEFAULT 'runtime'
                  CHECK (context IN ('runtime','skill_ingestion')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_formal_verify_cycle
  ON formal_verify_results (cycle_id);

CREATE INDEX IF NOT EXISTS idx_formal_verify_state
  ON formal_verify_results (state, created_at DESC);

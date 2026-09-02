/**
 * team-action-interop.test ; SP-B wire seam between two parallel workers.
 *
 * The PWA (`pwa/src/lib/team-action.ts`, W3) mirrors the SP-B body protocol
 * LOCALLY, per the PWA's no-SDK-bundle discipline ; the host (W2) validates the
 * received body with THIS package's parsers (W1). Both were built in parallel
 * against W1's pinned contract, so the failure mode to guard against is a silent
 * drift between the phone's builder output and the host's validator. This suite
 * feeds the EXACT JSON the phone emits (fixtures mirror the pwa builders
 * byte-for-byte) through the real SDK validators and asserts a clean round trip.
 * If the pwa mirror drifts from the contract, this breaks.
 */

import { describe, expect, it } from "vitest";
import {
  parseTeamCoordinateBody,
  parseTeamDelegateBody,
  parseTeamListBody,
  parseTeamSendBody,
  parseTeamStartBody,
} from "../index.js";

// ─── byte-shape mirrors of pwa/src/lib/team-action.ts (W3) ───────────────────
const isNonBlank = (s: string): boolean => s.trim().length > 0;

/** pwa `buildTeamSendBody` : trims target + body, keeps kind verbatim. */
function pwaBuildTeamSendBody(toTarget: string, kind: "ask" | "inform", body: string): string {
  return JSON.stringify({ toTarget: toTarget.trim(), kind, body: body.trim() });
}
/** pwa `buildTeamDelegateBody` : trims task, filters blank tools, omits an empty grant. */
function pwaBuildTeamDelegateBody(task: string, tools: readonly string[] = []): string {
  const kept = tools.filter(isNonBlank).map((t) => t.trim());
  return JSON.stringify(
    kept.length > 0 ? { task: task.trim(), grant: { tools: kept } } : { task: task.trim() },
  );
}
/** pwa `buildTeamCoordinateBody` : drops blank rows, trims, keeps order. */
function pwaBuildTeamCoordinateBody(tasks: readonly string[]): string {
  return JSON.stringify({
    branches: tasks.filter(isNonBlank).map((task) => ({ task: task.trim() })),
  });
}
/** pwa `buildTeamStartBody` : origin hardcoded "local", trims task, omits a
 * blank name, filters (not trims) tools into an optional grant. */
function pwaBuildTeamStartBody(task: string, name?: string, tools: readonly string[] = []): string {
  const trimmedName = name?.trim();
  const kept = tools.filter(isNonBlank);
  return JSON.stringify({
    origin: "local",
    task: task.trim(),
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(kept.length > 0 ? { grant: { tools: kept } } : {}),
  });
}

describe("SP-B team-action wire interop ; phone builder -> host validator", () => {
  it("team-send : the phone's emitted body parses to the expected struct", () => {
    const wire = pwaBuildTeamSendBody("  vera:demo  ", "ask", "  run the full suite  ");
    expect(parseTeamSendBody(wire)).toEqual({
      toTarget: "vera:demo",
      kind: "ask",
      body: "run the full suite",
    });
  });

  it("team-send : the `inform` kind round-trips too", () => {
    expect(parseTeamSendBody(pwaBuildTeamSendBody("peer:bot", "inform", "status?"))).toEqual({
      toTarget: "peer:bot",
      kind: "inform",
      body: "status?",
    });
  });

  it("delegate : a bare task (no tools) parses to { task }", () => {
    expect(parseTeamDelegateBody(pwaBuildTeamDelegateBody("  audit the repo  "))).toEqual({
      task: "audit the repo",
    });
  });

  it("delegate : task + a filtered tools grant round-trips", () => {
    const wire = pwaBuildTeamDelegateBody("build", ["read_file", "   ", "run_bash"]);
    expect(parseTeamDelegateBody(wire)).toEqual({
      task: "build",
      grant: { tools: ["read_file", "run_bash"] },
    });
  });

  it("coordinate : blank rows dropped, order preserved", () => {
    const wire = pwaBuildTeamCoordinateBody(["  branch a  ", "", "   ", "branch b"]);
    expect(parseTeamCoordinateBody(wire)).toEqual({
      branches: [{ task: "branch a" }, { task: "branch b" }],
    });
  });

  it("team-list : the phone's empty body parses to {}", () => {
    expect(parseTeamListBody("{}")).toEqual({});
  });

  it("start : a bare task (no name, no tools) parses to { origin, task }", () => {
    expect(parseTeamStartBody(pwaBuildTeamStartBody("  summarize the inbox  "))).toEqual({
      origin: "local",
      task: "summarize the inbox",
    });
  });

  it("start : task + name + a filtered tools grant round-trips", () => {
    const wire = pwaBuildTeamStartBody("build", "  scribe-2  ", ["read_file", "", "run_bash"]);
    expect(parseTeamStartBody(wire)).toEqual({
      origin: "local",
      task: "build",
      name: "scribe-2",
      grant: { tools: ["read_file", "run_bash"] },
    });
  });
});

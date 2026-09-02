/**
 * Reading fans out, writing does not.
 *
 * Every test below is about that asymmetry, because it is the only thing in
 * this module that can hurt someone: reading from the wrong Brain returns an
 * answer labelled with its origin, while writing to the wrong Brain files a
 * personal note into a shared memory and nobody finds out from the return
 * value.
 *
 * Elevated from `packages/cli/src/brain-roster.ts` on 2026-08-29 so the whole
 * Forge fleet reaches it through `BrainPort`, not just preste.
 */

import { describe, expect, it } from "vitest";
import {
  primaryTarget,
  resolveBrainRoster,
  resolveWriteTarget,
} from "../src/adapters/brain-roster.js";

/** The preste host's own prefix order and naming, kept verbatim. */
const PRESTE = { envPrefixes: ["PRESTE_BRAIN", "BRAIN"], primaryName: "personal" } as const;

const PRIMARY = {
  PRESTE_BRAIN_ID: "dbc8f6e3-personal",
  PRESTE_BRAIN_API_KEY: "key-personal",
  BRAIN_URL: "https://brain.api.vauban.tech",
};

describe("resolveBrainRoster ; what is reachable, and why something is not", () => {
  it("registers the primary Brain under the name the host gives it", () => {
    const r = resolveBrainRoster(PRIMARY, PRESTE);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0]).toMatchObject({ name: "personal", isPrimary: true });
    expect(r.skipped).toEqual([]);
  });

  it("adds a named Brain from its own group of variables", () => {
    const r = resolveBrainRoster(
      {
        ...PRIMARY,
        PRESTE_BRAIN_VAUBAN_ID: "1806d05c-vauban",
        PRESTE_BRAIN_VAUBAN_API_KEY: "key-vauban",
      },
      PRESTE,
    );
    expect(r.targets.map((t) => t.name).sort()).toEqual(["personal", "vauban"]);
    // Exactly one write destination, whatever the roster size.
    expect(r.targets.filter((t) => t.isPrimary)).toHaveLength(1);
  });

  // A Brain that 401s on every call LOOKS configured. That is the harder
  // failure to see, and it is exactly what killed an agent's episodic memory
  // on 2026-08-29: a port built with a URL and no credential.
  it("drops a Brain whose credential is missing, and says so", () => {
    const r = resolveBrainRoster({ ...PRIMARY, PRESTE_BRAIN_VAUBAN_ID: "1806d05c-vauban" }, PRESTE);
    expect(r.targets.map((t) => t.name)).toEqual(["personal"]);
    expect(r.skipped.join(" ")).toContain("vauban");
    expect(r.skipped.join(" ")).toContain("PRESTE_BRAIN_VAUBAN_API_KEY");
  });

  it("never registers a target with an empty credential", () => {
    const r = resolveBrainRoster(
      { ...PRIMARY, PRESTE_BRAIN_VAUBAN_ID: "id", PRESTE_BRAIN_VAUBAN_API_KEY: "" },
      PRESTE,
    );
    expect(r.targets.map((t) => t.name)).toEqual(["personal"]);
    for (const t of r.targets) expect(Boolean(t.apiKey || t.token)).toBe(true);
  });

  // The primary needs only a CREDENTIAL: an HTTP client resolves the default
  // Brain itself via discoverBrainId(). A first version of this module
  // required both and silently broke every deployment that supplies a key
  // alone, which is what production does.
  it("accepts a primary with a credential and no id, because the client discovers it", () => {
    const r = resolveBrainRoster({ PRESTE_BRAIN_API_KEY: "key-only" }, PRESTE);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0]).toMatchObject({ name: "personal", brainId: "", isPrimary: true });
  });

  it("drops a primary that has an id and no credential", () => {
    const r = resolveBrainRoster({ PRESTE_BRAIN_ID: "only-an-id" }, PRESTE);
    expect(r.targets).toEqual([]);
    expect(r.skipped.join(" ")).toContain("PRESTE_BRAIN_API_KEY");
  });

  // Discovery only covers the DEFAULT Brain, so a named one with no id has
  // nothing to discover and must still be refused.
  it("still drops a NAMED Brain that has a credential and no id", () => {
    const r = resolveBrainRoster({ ...PRIMARY, PRESTE_BRAIN_VAUBAN_API_KEY: "key-vauban" }, PRESTE);
    expect(r.targets.map((t) => t.name)).toEqual(["personal"]);
  });

  // `<PREFIX>_API_KEY` matches the `<PREFIX>_<NAME>_ID` shape closely enough
  // to be read as a Brain called "api" by a careless regex. The `_ID$` anchor
  // is the only thing preventing it.
  it("never invents a Brain out of the primary's own credential variable", () => {
    const r = resolveBrainRoster(PRIMARY, PRESTE);
    expect(r.targets.map((t) => t.name)).not.toContain("api");
  });

  it("never invents a Brain out of the primary's own id variable", () => {
    const r = resolveBrainRoster({ BRAIN_ID: "x", BRAIN_API_KEY: "k" });
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0]?.isPrimary).toBe(true);
  });

  it("turns an underscored variable name into a hyphenated Brain name", () => {
    const r = resolveBrainRoster(
      {
        ...PRIMARY,
        PRESTE_BRAIN_VAUBAN_ORG_ID: "org-id",
        PRESTE_BRAIN_VAUBAN_ORG_API_KEY: "org-key",
      },
      PRESTE,
    );
    expect(r.targets.map((t) => t.name)).toContain("vauban-org");
  });

  it("lets a named Brain live on its own host", () => {
    const r = resolveBrainRoster(
      {
        ...PRIMARY,
        PRESTE_BRAIN_LOCAL_ID: "local-id",
        PRESTE_BRAIN_LOCAL_API_KEY: "local-key",
        PRESTE_BRAIN_LOCAL_URL: "http://brain-api.brain-prod.svc.cluster.local:4000",
      },
      PRESTE,
    );
    const local = r.targets.find((t) => t.name === "local");
    expect(local?.baseUrl).toBe("http://brain-api.brain-prod.svc.cluster.local:4000");
    // And the others keep the default host.
    expect(r.targets.find((t) => t.name === "personal")?.baseUrl).toBe(
      "https://brain.api.vauban.tech",
    );
  });

  it("falls back to the host config for the primary, as before", () => {
    const r = resolveBrainRoster(
      {},
      { ...PRESTE, primaryFallback: { brainId: "cfg-id", apiKey: "cfg-key" } },
    );
    expect(r.targets[0]).toMatchObject({ brainId: "cfg-id", apiKey: "cfg-key" });
  });

  // Per-field fallback, not per-source: the pre-roster code read the id from
  // the environment and the credential from the config file independently, and
  // a deployment shaped that way must not lose its id.
  it("composes an env id with a config credential", () => {
    const r = resolveBrainRoster(
      { PRESTE_BRAIN_ID: "env-id" },
      { ...PRESTE, primaryFallback: { brainId: "cfg-id", apiKey: "cfg-key" } },
    );
    expect(r.targets[0]).toMatchObject({ brainId: "env-id", apiKey: "cfg-key" });
  });

  // The SDK deployment contract (`BRAIN_*`, per createBrainPortFromEnv) and
  // preste's (`PRESTE_BRAIN_*`) both have to work, because the Forge fleet and
  // the CLI now share this one resolver.
  it("reads the SDK deployment contract by default", () => {
    const r = resolveBrainRoster({
      BRAIN_ID: "sdk-id",
      BRAIN_TOKEN: "bearer-tok",
      BRAIN_VAUBAN_ID: "v-id",
      BRAIN_VAUBAN_API_KEY: "v-key",
    });
    expect(r.targets.map((t) => t.name).sort()).toEqual(["default", "vauban"]);
    expect(r.targets.find((t) => t.isPrimary)?.token).toBe("bearer-tok");
  });

  it("honours the host's prefix order when both contracts are set", () => {
    const env = { BRAIN_API_KEY: "sdk-key", PRESTE_BRAIN_API_KEY: "preste-key" };
    expect(resolveBrainRoster(env, PRESTE).targets[0]?.apiKey).toBe("preste-key");
    expect(resolveBrainRoster(env).targets[0]?.apiKey).toBe("sdk-key");
  });

  it("accepts a bearer token as the credential for a named Brain", () => {
    const r = resolveBrainRoster({
      BRAIN_API_KEY: "k",
      BRAIN_VAUBAN_ID: "v-id",
      BRAIN_VAUBAN_TOKEN: "v-tok",
    });
    expect(r.targets.find((t) => t.name === "vauban")).toMatchObject({ token: "v-tok" });
    expect(r.skipped).toEqual([]);
  });

  it("keeps the roster order deterministic whatever the env order", () => {
    const names = (env: Record<string, string>) =>
      resolveBrainRoster(env).targets.map((t) => t.name);
    const a = { BRAIN_API_KEY: "k", BRAIN_ZED_ID: "z", BRAIN_ZED_API_KEY: "zk" };
    expect(names({ ...a, BRAIN_ALPHA_ID: "a", BRAIN_ALPHA_API_KEY: "ak" })).toEqual([
      "default",
      "alpha",
      "zed",
    ]);
  });
});

describe("resolveWriteTarget ; an unknown name is refused, never defaulted", () => {
  const roster = resolveBrainRoster(
    {
      ...PRIMARY,
      PRESTE_BRAIN_VAUBAN_ID: "1806d05c-vauban",
      PRESTE_BRAIN_VAUBAN_API_KEY: "key-vauban",
    },
    PRESTE,
  );

  it("writes to the primary when no destination is named", () => {
    const r = resolveWriteTarget(roster, undefined);
    expect(r.ok && r.target.name).toBe("personal");
  });

  it("writes to a named Brain when asked", () => {
    const r = resolveWriteTarget(roster, "vauban");
    expect(r.ok && r.target.name).toBe("vauban");
  });

  it("accepts the name as the founder would type it", () => {
    expect(resolveWriteTarget(roster, "  Vauban ").ok).toBe(true);
  });

  // THE CLAUSE THAT MATTERS. Falling back to the default on a typo turns a
  // slip into a misfiled secret: the model asked for one Brain, the note
  // landed in another, and the return value said "saved".
  it("REFUSES an unknown name rather than falling back to the default", () => {
    const r = resolveWriteTarget(roster, "vaubanne");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("vaubanne");
      // And it names what IS available, so the model can correct itself.
      expect(r.error).toContain("personal");
      expect(r.error).toContain("vauban");
    }
  });

  it("refuses cleanly when no Brain is configured at all", () => {
    const empty = resolveBrainRoster({}, PRESTE);
    expect(primaryTarget(empty)).toBeNull();
    const r = resolveWriteTarget(empty, undefined, PRESTE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("PRESTE_BRAIN_ID");
  });
});

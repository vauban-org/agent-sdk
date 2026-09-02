---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Agent Identity & Persona

**Module:** `@vauban-org/agent-sdk` · **Since:** CC v3.1 sprint-562 (Livrable E, 2026-05-14)

An `AgentPersona` is a structured description of how an agent communicates — tone, formality, domain expertise, and response-shape preferences. The persona travels from Brain Tier 3 (semantic storage) through the CC server as a system-prompt prefix, and can be overridden locally via `~/.preste/persona.yaml`.

## Quick start

```typescript
import {
  buildPersonaPromptBlock,
  mergePersona,
  DEFAULT_PERSONA,
  validatePersona,
} from "@vauban-org/agent-sdk";
import type { AgentPersona } from "@vauban-org/agent-sdk";

const persona: AgentPersona = {
  identity: {
    name: "ARCHITECT",
    role: "Senior Cairo/TypeScript engineer",
    tone: "concise",
    formality: "technical",
    language: "en",
  },
  domain_expertise: ["Starknet", "TypeScript", "ZK proofs"],
  communication: {
    acknowledgment_style: "minimal",
    explain_reasoning: "on_error",
  },
};

const systemPrompt =
  "You are an agent in the Vauban ecosystem." +
  buildPersonaPromptBlock(persona);
```

The `buildPersonaPromptBlock` call appends the block only when actionable fields are present — it is safe to concatenate unconditionally.

---

## `AgentPersona` schema

All fields are optional. Zod validation enforces the limits below; `PersonaSchema.parse(input)` throws on violation.

```typescript
interface AgentPersona {
  identity?: {
    name?: string;       // max 64 chars
    role?: string;       // max 256 chars
    tone?: "concise" | "detailed" | "pedagogical";
    formality?: "casual" | "formal" | "technical";
    language?: string;   // BCP 47, e.g. "en", "fr-FR"
  };
  traits?: string[];           // max 16 items, max 64 chars each
  domain_expertise?: string[]; // max 32 items, max 128 chars each
  communication?: {
    max_response_length?: number;
    use_analogies?: boolean;
    explain_reasoning?: "always" | "on_error" | "never";
    acknowledgment_style?: "minimal" | "detailed" | "none";
  };
}
```

`DEFAULT_PERSONA` is applied before any user-defined value:

```typescript
const DEFAULT_PERSONA: AgentPersona = {
  identity: { tone: "concise", formality: "technical", language: "en" },
  traits: [],
  domain_expertise: [],
  communication: { explain_reasoning: "on_error", acknowledgment_style: "minimal" },
};
```

---

## `buildPersonaPromptBlock(persona)`

Converts an `AgentPersona` to a compact system-prompt block bounded by `--- persona ---` / `--- end persona ---` markers.

```typescript
import { buildPersonaPromptBlock } from "@vauban-org/agent-sdk";

const block = buildPersonaPromptBlock({
  identity: { name: "SCRIBE", tone: "pedagogical", formality: "formal" },
  domain_expertise: ["technical writing", "API documentation"],
  communication: { explain_reasoning: "always" },
});

// block ===
// \n--- persona ---
// You are SCRIBE.
// Communication style: pedagogical, formal.
// Domain expertise: technical writing, API documentation.
// Always explain your reasoning step by step.
// --- end persona ---
```

**Properties:**

- Returns `""` when the persona has no actionable fields — safe for unconditional concatenation.
- `language` field only emits an instruction when it differs from `"en"`.
- Empty `traits` / `domain_expertise` arrays produce no output.
- The leading `\n` ensures correct spacing when appended to an existing system prompt.

---

## Merge semantics

`mergePersona(base, local)` applies `local` on top of `base` field-by-field. Brain Tier 3 is the base; `~/.preste/persona.yaml` is the local override.

```typescript
import { mergePersona, DEFAULT_PERSONA } from "@vauban-org/agent-sdk";

const brainPersona: AgentPersona = {
  identity: { name: "BUILDER", tone: "concise" },
  domain_expertise: ["Cairo", "TypeScript"],
};

const localOverride: AgentPersona = {
  identity: { tone: "detailed" },       // overrides tone only
  domain_expertise: ["Rust"],           // REPLACES the array entirely
};

const resolved = mergePersona(
  mergePersona(DEFAULT_PERSONA, brainPersona),
  localOverride,
);
// resolved.identity.name === "BUILDER"  (from brainPersona)
// resolved.identity.tone === "detailed" (from localOverride)
// resolved.domain_expertise === ["Rust"] (array replaced, not extended)
```

!!! warning "Array replacement semantics"
    `traits` and `domain_expertise` are **replaced**, not extended. If you want to extend the Brain-stored array, concatenate before calling `mergePersona`:
    ```typescript
    const extended = mergePersona(base, {
      ...local,
      domain_expertise: [...(base.domain_expertise ?? []), ...(local.domain_expertise ?? [])],
    });
    ```

---

## System-level injection (CC server)

Set `CC_AGENT_PERSONA_JSON` on the CC server to inject the persona as a system message prefix for every agent call, without modifying agent code.

**Generate the env value:**

```bash
echo '{"identity":{"name":"ARCHITECT","role":"Senior Cairo/TypeScript engineer","tone":"concise","formality":"technical"},"domain_expertise":["Starknet","TypeScript","ZK proofs"],"communication":{"acknowledgment_style":"minimal","explain_reasoning":"on_error"}}' | base64 -w0
```

```bash
export CC_AGENT_PERSONA_JSON="<base64 output>"
```

The CC server decodes, validates via `PersonaSchema.parse`, and calls `buildPersonaPromptBlock` before prepending to each agent system message.

---

## CLI persona management

The `preste persona` sub-command manages the local `~/.preste/persona.yaml` override file.

```bash
preste persona show                                         # display resolved persona (Brain + local merge)
preste persona set --name ARCHITECT --role "..." --tone concise --formality technical
preste persona export persona.yaml                          # write to YAML file
preste persona import persona.yaml                          # load from YAML file (validates schema)
preste persona reset                                        # delete ~/.preste/persona.yaml (revert to Brain-only)
```

`preste persona show` prints the fully-resolved persona (Brain base + local override + defaults) and the rendered `buildPersonaPromptBlock` output so you can inspect what the model will receive.

---

## Validation

```typescript
import { validatePersona } from "@vauban-org/agent-sdk";

try {
  const persona = validatePersona(untrustedInput);
} catch (err) {
  // ZodError — inspect err.issues for field-level messages
}
```

`validatePersona` wraps `PersonaSchema.parse` and throws `ZodError` on invalid input. Call it at ingestion boundaries (e.g., when loading `~/.preste/persona.yaml` or deserializing from Brain).

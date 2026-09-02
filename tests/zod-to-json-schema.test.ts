/**
 * Tests for packages/agent-sdk/src/tools/zod-to-json-schema.ts
 *
 * Coverage:
 *   zodToJsonSchema — z.object (required/optional fields, nested object),
 *                     z.string, z.number, z.boolean, z.array, z.enum,
 *                     z.literal, z.record, z.union,
 *                     z.optional (not in required), z.default (not in required),
 *                     description propagation, non-object wrapping
 *
 * Ref: test coverage for agent-sdk/tools/zod-to-json-schema.ts (no prior tests)
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../src/tools/zod-to-json-schema.js";

describe("zodToJsonSchema", () => {
  it("converts z.object with required and optional fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect((result.properties as Record<string, unknown>).name).toEqual({
      type: "string",
    });
    expect(result.required).toEqual(["name"]);
    expect(result.required).not.toContain("age");
  });

  it("converts z.string", () => {
    const schema = z.object({ msg: z.string() });
    const result = zodToJsonSchema(schema);
    expect((result.properties as Record<string, unknown>).msg).toEqual({
      type: "string",
    });
  });

  it("converts z.number", () => {
    const schema = z.object({ count: z.number() });
    const result = zodToJsonSchema(schema);
    expect((result.properties as Record<string, unknown>).count).toEqual({
      type: "number",
    });
  });

  it("converts z.boolean", () => {
    const schema = z.object({ flag: z.boolean() });
    const result = zodToJsonSchema(schema);
    expect((result.properties as Record<string, unknown>).flag).toEqual({
      type: "boolean",
    });
  });

  it("converts z.array", () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = zodToJsonSchema(schema);
    const tags = (result.properties as Record<string, unknown>).tags as Record<
      string,
      unknown
    >;
    expect(tags.type).toBe("array");
    expect(tags.items).toEqual({ type: "string" });
  });

  it("converts z.enum to string enum", () => {
    const schema = z.object({ level: z.enum(["a", "b", "c"]) });
    const result = zodToJsonSchema(schema);
    const level = (result.properties as Record<string, unknown>)
      .level as Record<string, unknown>;
    expect(level.type).toBe("string");
    expect(level.enum).toEqual(["a", "b", "c"]);
  });

  it("converts z.literal", () => {
    const schema = z.object({ type: z.literal("event") });
    const result = zodToJsonSchema(schema);
    const type = (result.properties as Record<string, unknown>).type as Record<
      string,
      unknown
    >;
    expect(type.const).toBe("event");
    expect(type.type).toBe("string");
  });

  it("converts z.record to object with additionalProperties", () => {
    const schema = z.object({ meta: z.record(z.string(), z.number()) });
    const result = zodToJsonSchema(schema);
    const meta = (result.properties as Record<string, unknown>).meta as Record<
      string,
      unknown
    >;
    expect(meta.type).toBe("object");
    expect(meta.additionalProperties).toEqual({ type: "number" });
  });

  it("converts z.union to oneOf", () => {
    const schema = z.object({
      val: z.union([z.string(), z.number()]),
    });
    const result = zodToJsonSchema(schema);
    const val = (result.properties as Record<string, unknown>).val as Record<
      string,
      unknown
    >;
    expect(Array.isArray(val.oneOf)).toBe(true);
    expect((val.oneOf as unknown[]).length).toBe(2);
  });

  it("z.default field is NOT required", () => {
    const schema = z.object({
      limit: z.number().default(10),
    });
    const result = zodToJsonSchema(schema);
    expect(result.required).toBeUndefined();
  });

  it("propagates .describe() to description field", () => {
    const schema = z.object({
      query: z.string().describe("Search query string"),
    });
    const result = zodToJsonSchema(schema);
    const query = (result.properties as Record<string, unknown>)
      .query as Record<string, unknown>;
    expect(query.description).toBe("Search query string");
  });

  it("wraps non-object schemas in { type: object, properties: { value: ... } }", () => {
    const result = zodToJsonSchema(z.string());
    expect(result.type).toBe("object");
    expect((result.properties as Record<string, unknown>).value).toEqual({
      type: "string",
    });
  });

  it("handles nested objects", () => {
    const schema = z.object({
      config: z.object({ debug: z.boolean() }),
    });
    const result = zodToJsonSchema(schema);
    const config = (result.properties as Record<string, unknown>)
      .config as Record<string, unknown>;
    expect(config.type).toBe("object");
    const configProps = config.properties as Record<string, unknown>;
    expect(configProps.debug).toEqual({ type: "boolean" });
  });

  // Regression: constraints must be serialized so a weak LLM sees them in the
  // tool schema, not only at server-side validation (spawn_parallel_agents bug).
  it("serializes array .min()/.max() as minItems/maxItems", () => {
    const schema = z.object({
      agents: z.array(z.string()).min(2).max(5),
    });
    const result = zodToJsonSchema(schema);
    const agents = (result.properties as Record<string, unknown>)
      .agents as Record<string, unknown>;
    expect(agents.minItems).toBe(2);
    expect(agents.maxItems).toBe(5);
  });

  it("serializes number .min()/.max() as minimum/maximum and .int() as integer", () => {
    const schema = z.object({
      timeout_ms: z.number().min(5000).max(300000),
      max_steps: z.number().int().min(1).max(100),
    });
    const result = zodToJsonSchema(schema);
    const props = result.properties as Record<string, unknown>;
    const timeout = props.timeout_ms as Record<string, unknown>;
    expect(timeout.minimum).toBe(5000);
    expect(timeout.maximum).toBe(300000);
    const maxSteps = props.max_steps as Record<string, unknown>;
    expect(maxSteps.type).toBe("integer");
    expect(maxSteps.minimum).toBe(1);
    expect(maxSteps.maximum).toBe(100);
  });

  it("emits additionalProperties:false for a .strict() object", () => {
    const schema = z.object({ task: z.string() }).strict();
    const result = zodToJsonSchema(schema);
    expect(result.additionalProperties).toBe(false);
  });

  it("omits constraints when none are set (no regression on bare types)", () => {
    const result = zodToJsonSchema(z.object({ x: z.array(z.string()) }));
    const x = (result.properties as Record<string, unknown>).x as Record<
      string,
      unknown
    >;
    expect(x).toEqual({ type: "array", items: { type: "string" } });
  });
});

import { z } from "zod";
import type { MCPToolDefinition } from "./types.js";

/**
 * Minimal Zod-to-JSON-Schema converter for MCP tool definitions.
 * Handles the subset of Zod types used in agent tool parameters:
 * z.object, z.string, z.number, z.boolean, z.array, z.enum, z.optional, z.default.
 *
 * No external dependency — avoids adding zod-to-json-schema to direct deps.
 * @public
 */
export function zodToJsonSchema(
  schema: z.ZodTypeAny,
): MCPToolDefinition["inputSchema"] {
  const jsonSchema = convertZodType(schema);
  if (jsonSchema.type === "object") {
    return jsonSchema as MCPToolDefinition["inputSchema"];
  }
  return { type: "object", properties: { value: jsonSchema } };
}

function convertZodType(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional) {
    const inner = convertZodType(schema.unwrap());
    return withDescription(schema, inner);
  }

  if (schema instanceof z.ZodDefault) {
    const inner = convertZodType(schema._def.innerType);
    inner.default = schema._def.defaultValue();
    return withDescription(schema, inner);
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertZodType(value);
      if (!isOptionalType(value)) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) {
      result.required = required;
    }
    // A .strict() object rejects unknown keys at validation time; surface that
    // to the LLM as `additionalProperties: false` so it does not emit extra
    // fields and then fail an opaque server-side validation it cannot see.
    if ((schema._def as { unknownKeys?: string }).unknownKeys === "strict") {
      result.additionalProperties = false;
    }
    return withDescription(schema, result);
  }

  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string" };
    const def = schema._def as {
      minLength?: { value: number } | null;
      maxLength?: { value: number } | null;
    };
    if (def.minLength != null) out.minLength = def.minLength.value;
    if (def.maxLength != null) out.maxLength = def.maxLength.value;
    return withDescription(schema, out);
  }

  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: "number" };
    const checks =
      (schema._def as { checks?: Array<{ kind: string; value: number }> })
        .checks ?? [];
    for (const c of checks) {
      if (c.kind === "min") out.minimum = c.value;
      else if (c.kind === "max") out.maximum = c.value;
      else if (c.kind === "int") out.type = "integer";
    }
    return withDescription(schema, out);
  }

  if (schema instanceof z.ZodBoolean) {
    return withDescription(schema, { type: "boolean" });
  }

  if (schema instanceof z.ZodArray) {
    const out: Record<string, unknown> = {
      type: "array",
      items: convertZodType(schema.element),
    };
    const def = schema._def as {
      minLength?: { value: number } | null;
      maxLength?: { value: number } | null;
    };
    if (def.minLength != null) out.minItems = def.minLength.value;
    if (def.maxLength != null) out.maxItems = def.maxLength.value;
    return withDescription(schema, out);
  }

  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, {
      type: "string",
      enum: schema.options as string[],
    });
  }

  if (schema instanceof z.ZodLiteral) {
    const jsonType = schema.value === null ? "null" : typeof schema.value;
    return withDescription(schema, { type: jsonType, const: schema.value });
  }

  if (schema instanceof z.ZodRecord) {
    return withDescription(schema, {
      type: "object",
      additionalProperties: convertZodType(schema._def.valueType),
    });
  }

  if (schema instanceof z.ZodUnion) {
    const options = (schema._def.options as z.ZodTypeAny[]).map(convertZodType);
    return withDescription(schema, { oneOf: options });
  }

  return {};
}

function withDescription(
  schema: z.ZodTypeAny,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.description) {
    result.description = schema.description;
  }
  return result;
}

function isOptionalType(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional) return true;
  if (schema instanceof z.ZodDefault) return true;
  return false;
}

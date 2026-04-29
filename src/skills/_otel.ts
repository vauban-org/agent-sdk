/**
 * Optional OTEL helper for skills.
 *
 * If env OTEL_EXPORTER_OTLP_ENDPOINT is set, wrap fn in a span; else no-op.
 * Internal — not part of the public Skill Catalog API.
 *
 * @internal
 */
import { trace } from "@opentelemetry/api";

export async function withSkillSpan<T>(
  skillName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return fn();
  }
  const tracer = trace.getTracer("@vauban-org/agent-sdk:skills");
  return tracer.startActiveSpan(`skill.${skillName}`, async (span) => {
    try {
      const result = await fn();
      span.setAttribute("skill.name", skillName);
      span.end();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.end();
      throw err;
    }
  });
}

/**
 * OODA boot errors — dependency validation (plan v6 §3.7).
 *
 * @public
 */

/**
 * Thrown at boot when a required dependency (e.g. `deps.llm`) is missing
 * and `SDK_STRICT_DEPS` mode is enabled (default: true).
 * @public
 */
export class MissingDependencyError extends Error {
  readonly port: string;

  constructor(port: string) {
    super(`OODAAgent requires deps.${port}. BYOM is mandatory in strict mode.`);
    this.name = "MissingDependencyError";
    this.port = port;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the `deps` object is structurally invalid (e.g. wrong type
 * for a known port, conflicting constraints).
 * @public
 */
export class DepsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepsValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

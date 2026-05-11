import { SCHEMA_VERSION } from "../agents/schemas.js";

export interface ValidationResult {
  valid: boolean;
  failureReason?: string;
}

export function validateSchemaVersion(parsed: unknown): ValidationResult {
  if (typeof parsed !== "object" || parsed === null) {
    return { valid: true };
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.schema_version;
  if (version === undefined) {
    return { valid: true };
  }
  if (version !== SCHEMA_VERSION) {
    return { valid: false, failureReason: "schema-version-mismatch" };
  }
  return { valid: true };
}
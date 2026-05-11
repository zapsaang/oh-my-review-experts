import { describe, expect, it } from "vitest";
import { validateSchemaVersion } from "../../src/workflow/validate-result.js";
import { SCHEMA_VERSION } from "../../src/agents/schemas.js";

describe("validateSchemaVersion", () => {
  it("returns valid=true when schema_version matches", () => {
    const result = validateSchemaVersion({ schema_version: SCHEMA_VERSION });
    expect(result.valid).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it("returns valid=false with schema-version-mismatch when version differs", () => {
    const result = validateSchemaVersion({ schema_version: "0" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });

  it("returns valid=true when schema_version is missing (backward compat)", () => {
    const result = validateSchemaVersion({ status: "completed" });
    expect(result.valid).toBe(true);
    expect(result.failureReason).toBeUndefined();
  });

  it("returns valid=true for non-object input (graceful)", () => {
    expect(validateSchemaVersion(null).valid).toBe(true);
    expect(validateSchemaVersion(undefined).valid).toBe(true);
    expect(validateSchemaVersion("string").valid).toBe(true);
    expect(validateSchemaVersion(123).valid).toBe(true);
    expect(validateSchemaVersion([]).valid).toBe(true);
  });

  it("returns valid=false for future version mismatch", () => {
    const result = validateSchemaVersion({ schema_version: "999" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });

  it("handles empty string version as mismatch", () => {
    const result = validateSchemaVersion({ schema_version: "" });
    expect(result.valid).toBe(false);
    expect(result.failureReason).toBe("schema-version-mismatch");
  });
});

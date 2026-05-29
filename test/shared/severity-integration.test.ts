import { describe, it, expect } from "vitest";

/**
 * Integration test: SEVERITY_VALUES re-exported from agents/schemas.ts
 * must reference the same underlying value as src/shared/severity.ts.
 */

describe("severity integration — agents/schemas re-exports shared/severity", () => {
  it("SEVERITY_VALUES from agents/schemas.js deep-equals SEVERITY_VALUES from shared/severity.js", async () => {
    const fromAgents = await import("../../src/agents/schemas.js");
    const fromShared = await import("../../src/shared/severity.js");

    expect(fromAgents.SEVERITY_VALUES).toEqual(fromShared.SEVERITY_VALUES);
  });

  it("SEVERITY_VALUES from agents/schemas.js is the same array reference as shared/severity.js", async () => {
    const fromAgents = await import("../../src/agents/schemas.js");
    const fromShared = await import("../../src/shared/severity.js");

    expect(fromAgents.SEVERITY_VALUES).toBe(fromShared.SEVERITY_VALUES);
  });
});

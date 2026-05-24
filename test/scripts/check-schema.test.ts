import { describe, it, expect } from "vitest";
import { runCheckSchema } from "../../scripts/check-schema.js";

describe("check-schema", () => {
  it("returns ok=true when tracked and generated schemas match", () => {
    const canonical = JSON.stringify({ type: "object", properties: {} }, null, 2) + "\n";
    const result = runCheckSchema(canonical, canonical);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("OK");
    expect(result.diff).toBeUndefined();
  });

  it("returns ok=false with diff when tracked and generated schemas differ", () => {
    const tracked = JSON.stringify({ type: "object", properties: { a: { type: "string" } } }, null, 2) + "\n";
    const generated = JSON.stringify({ type: "object", properties: { a: { type: "number" } } }, null, 2) + "\n";
    const result = runCheckSchema(tracked, generated);
    expect(result.ok).toBe(false);
    expect(result.diff).toBeDefined();
    expect(result.diff!.length).toBeGreaterThan(0);
  });
});

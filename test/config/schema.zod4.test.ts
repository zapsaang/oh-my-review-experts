import { describe, it, expect } from "vitest";
import { OmreConfigSchema } from "../../src/config/schema.js";

describe("Zod 4 specific schema behaviors", () => {
  it("regex validation surfaces custom error messages", () => {
    const result = OmreConfigSchema.safeParse({
      command: { name: "has space" }
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("alphanumeric");
    }
  });

  it("rejects forceWholeTargetAboveSlices above 100", () => {
    expect(() => OmreConfigSchema.parse({
      slicing: { forceWholeTargetAboveSlices: 101 }
    })).toThrow();
  });

  it("accepts forceWholeTargetAboveSlices at boundary 100", () => {
    const result = OmreConfigSchema.parse({
      slicing: { forceWholeTargetAboveSlices: 100 }
    });
    expect(result.slicing.forceWholeTargetAboveSlices).toBe(100);
  });

  it("rejects unknown slice type in bySliceType", () => {
    expect(() => OmreConfigSchema.parse({
      reviewers: { bySliceType: { "unknown-type": ["spec"] } }
    })).toThrow();
  });
});

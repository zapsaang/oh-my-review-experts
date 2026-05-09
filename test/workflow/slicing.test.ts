import { describe, it, expect } from "vitest";
import { heuristicSlices, estimatePlan } from "../../src/workflow/slicing.js";
import { OmreConfigSchema } from "../../src/config/schema.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return OmreConfigSchema.parse(overrides);
}

const CLASSIFICATION_CASES: Array<{ file: string; expected: string }> = [
  { file: "README.md", expected: "docs-only" },
  { file: "docs/guide.md", expected: "docs-only" },
  { file: "src/app.test.ts", expected: "test-only" },
  { file: "__tests__/setup.ts", expected: "test-only" },
  { file: "spec/helpers.ts", expected: "test-only" },
  { file: "src/app.spec.ts", expected: "test-only" },
  { file: "test-helpers.ts", expected: "test-only" },
  { file: "db/migration_001.sql", expected: "migration" },
  { file: "api/openapi.yaml", expected: "api-contract" },
  { file: "package.json", expected: "dependency-change" },
  { file: "package-lock.json", expected: "dependency-change" },
  { file: ".github/workflows/ci.yml", expected: "infra-change" },
  { file: "src/shared/utils.ts", expected: "shared-library" },
  { file: "src/users/service.ts", expected: "business-module" },
];

const NON_TEST_CASES = [
  "src/utils/testing-utils.ts",
  "src/components/spectacle.ts",
  "src/inspector.ts",
  "src/prospect.ts",
];

describe("heuristicSlices", () => {
  it.each(CLASSIFICATION_CASES)("classifies $file as $expected", ({ file, expected }) => {
    const config = makeConfig({ slicing: { skipDocsOnly: false } });
    const slices = heuristicSlices([file], config);
    expect(slices.length).toBe(1);
    expect(slices[0].slice_type).toBe(expected);
  });

  it.each(NON_TEST_CASES)("does not misclassify %s as test-only", (file) => {
    const config = makeConfig();
    const slices = heuristicSlices([file], config);
    if (slices.length > 0) {
      expect(slices[0].slice_type).not.toBe("test-only");
    }
  });

  it("skips docs-only files when configured", () => {
    const config = makeConfig({ slicing: { skipDocsOnly: true } });
    const slices = heuristicSlices(["README.md", "docs/guide.md", "src/app.ts"], config);
    expect(slices.length).toBe(1);
    expect(slices[0].slice_type).not.toBe("docs-only");
  });

  it("includes docs-only files when skipDocsOnly is false", () => {
    const config = makeConfig({ slicing: { skipDocsOnly: false } });
    const slices = heuristicSlices(["README.md"], config);
    expect(slices.some((s) => s.slice_type === "docs-only")).toBe(true);
  });

  it("returns empty slices for empty file list", () => {
    const config = makeConfig();
    const slices = heuristicSlices([], config);
    expect(slices).toEqual([]);
  });

  it("respects maxSlices limit", () => {
    const config = makeConfig({ slicing: { maxSlices: 2 } });
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const slices = heuristicSlices(files, config);
    expect(slices.length).toBeLessThanOrEqual(2);
  });

  it("groups business-module files by module key", () => {
    const config = makeConfig();
    const slices = heuristicSlices(["src/users/a.ts", "src/orders/b.ts"], config);
    const types = slices.map((s) => s.slice_type);
    expect(types.filter((t) => t === "business-module").length).toBeGreaterThanOrEqual(1);
  });
});

describe("estimatePlan", () => {
  it("returns whole-target fallback when heuristicSlices yields empty", () => {
    const config = makeConfig();
    const plan = estimatePlan([], config);
    expect(plan.slices.length).toBe(1);
    expect(plan.slices[0].slice_id).toBe("whole-target");
    expect(plan.slices[0].files).toEqual([]);
    expect(plan.estimatedTasks).toBeGreaterThanOrEqual(2);
  });

  it("enables compact mode when tasks exceed threshold", () => {
    const config = makeConfig({
      costGuardrail: { compactModeThreshold: 5 },
      slicing: { maxSlices: 10 },
    });
    const plan = estimatePlan(
      Array.from({ length: 50 }, (_, i) => `src/module${i}/file.ts`),
      config
    );
    expect(plan.compactMode).toBe(true);
  });

  it("uses default reviewers when bySliceType entry is empty", () => {
    const config = makeConfig({
      reviewers: {
        default: ["spec", "quality"],
        bySliceType: { "shared-library": [] },
      },
    });
    const plan = estimatePlan(["src/shared/utils.ts"], config);
    const reviewers = Object.values(plan.selectedReviewers).flat();
    expect(reviewers).toContain("spec");
    expect(reviewers).toContain("quality");
  });

  it("uses bySliceType reviewers when available", () => {
    const config = makeConfig({
      reviewers: {
        default: ["spec", "quality"],
        bySliceType: { "test-only": ["spec"] },
      },
    });
    const plan = estimatePlan(["src/app.test.ts"], config);
    const sliceReviewers = plan.selectedReviewers[plan.slices[0].slice_id];
    expect(sliceReviewers).toEqual(["spec"]);
  });

  it("reduces test-only reviewers when skipTestOnlyHeavyReview is true", () => {
    const config = makeConfig({ slicing: { skipTestOnlyHeavyReview: true } });
    const plan = estimatePlan(["src/app.test.ts"], config);
    const sliceReviewers = plan.selectedReviewers[plan.slices[0].slice_id];
    expect(sliceReviewers).toEqual(["spec", "quality"]);
  });

  it("uses default reviewers for test-only when skipTestOnlyHeavyReview is false", () => {
    const config = makeConfig({ slicing: { skipTestOnlyHeavyReview: false } });
    const plan = estimatePlan(["src/app.test.ts"], config);
    const sliceReviewers = plan.selectedReviewers[plan.slices[0].slice_id];
    expect(sliceReviewers).toEqual(["spec", "quality", "security", "performance", "concurrency"]);
  });

  it("forces whole-target mode when slices exceed forceWholeTargetAboveSlices threshold", () => {
    const config = makeConfig({
      slicing: { enabled: true, maxSlices: 20, forceWholeTargetAboveSlices: 3 },
    });
    const files = ["src/a/a.ts", "src/b/b.ts", "src/c/c.ts", "src/d/d.ts"];
    const plan = estimatePlan(files, config);
    expect(plan.slices.length).toBe(1);
    expect(plan.slices[0].slice_id).toBe("whole-target");
    expect(plan.slices[0].files).toEqual(files);
  });

  it("keeps normal slicing when slices do not exceed forceWholeTargetAboveSlices threshold", () => {
    const config = makeConfig({
      slicing: { enabled: true, maxSlices: 20, forceWholeTargetAboveSlices: 5 },
    });
    const files = ["src/a/a.ts", "src/b/b.ts"];
    const plan = estimatePlan(files, config);
    expect(plan.slices.length).toBeGreaterThanOrEqual(1);
    expect(plan.slices[0].slice_id).not.toBe("whole-target");
  });
});

describe("security", () => {
  it("handles path traversal characters in file names without misclassification", () => {
    const config = makeConfig();
    const files = ["../../../etc/passwd", "src/app.ts"];
    const slices = heuristicSlices(files, config);
    expect(slices.some((s) => s.files.includes("../../../etc/passwd"))).toBe(true);
    expect(slices.length).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect } from "vitest";
import {
  CONTRACT,
  REVIEWER_PROMPTS,
  COMPLETE_REVIEWER_PROMPTS,
  SLICE_ARBITER_PROMPT,
  GLOBAL_ARBITER_PROMPT,
  composePrompt,
  buildHandoffProtocol,
  buildMandatoryOutputPersistence,
  buildReportWriterInputRule,
  buildSubagentCatalog,
} from "../../src/agents/prompts.js";
import type { ReviewDimensionType } from "../../src/config/schema.js";

describe("CONTRACT", () => {
  it("contains expected rules", () => {
    expect(CONTRACT).toContain("Output strict JSON only when asked for machine-readable results");
    expect(CONTRACT).toContain("Do not wrap JSON in markdown fences");
    expect(CONTRACT).toContain("Never fabricate issues");
    expect(CONTRACT).toContain("evidence-backed");
  });
});

describe("REVIEWER_PROMPTS", () => {
  it("contains all expected dimensions", () => {
    const dimensions: ReviewDimensionType[] = ["spec", "quality", "security", "performance", "concurrency"];
    for (const dimension of dimensions) {
      expect(REVIEWER_PROMPTS[dimension]).toBeDefined();
      expect(REVIEWER_PROMPTS[dimension].length).toBeGreaterThan(0);
    }
  });

  it("does not include CONTRACT in individual prompts", () => {
    for (const [dimension, prompt] of Object.entries(REVIEWER_PROMPTS)) {
      expect(prompt, `dimension ${dimension} should not contain CONTRACT`).not.toContain(CONTRACT.trim());
    }
  });

  it("includes severity enum instructions for all dimensions", () => {
    for (const [dimension, prompt] of Object.entries(REVIEWER_PROMPTS)) {
      expect(prompt, `dimension ${dimension} should contain severity enum`).toContain("severity from: critical, high, medium, low");
    }
  });

  it("includes confidence enum instructions for all dimensions", () => {
    for (const [dimension, prompt] of Object.entries(REVIEWER_PROMPTS)) {
      expect(prompt, `dimension ${dimension} should contain confidence enum`).toContain("confidence from: high, medium, low");
    }
  });

  it("includes performance classification enum for performance dimension", () => {
    expect(REVIEWER_PROMPTS.performance).toContain("provable-regression");
    expect(REVIEWER_PROMPTS.performance).toContain("likely-regression");
    expect(REVIEWER_PROMPTS.performance).toContain("benchmark-needed");
  });

  it("includes concurrency classification enum for concurrency dimension", () => {
    expect(REVIEWER_PROMPTS.concurrency).toContain("race-condition");
    expect(REVIEWER_PROMPTS.concurrency).toContain("atomicity-violation");
    expect(REVIEWER_PROMPTS.concurrency).toContain("deadlock");
    expect(REVIEWER_PROMPTS.concurrency).toContain("distributed-inconsistency");
  });
});

describe("composePrompt", () => {
  it("prepends CONTRACT to each dimension prompt", () => {
    const dimensions: ReviewDimensionType[] = ["spec", "quality", "security", "performance", "concurrency"];
    for (const dimension of dimensions) {
      const composed = composePrompt(dimension);
      expect(composed.startsWith(CONTRACT.trim()), `dimension ${dimension} should start with CONTRACT`).toBe(true);
      expect(composed).toContain(REVIEWER_PROMPTS[dimension]);
    }
  });

  it("returns identical results for repeated calls", () => {
    const d1 = composePrompt("spec");
    const d2 = composePrompt("spec");
    expect(d1).toBe(d2);
  });
});

describe("COMPLETE_REVIEWER_PROMPTS", () => {
  it("contains all expected dimensions", () => {
    const dimensions: ReviewDimensionType[] = ["spec", "quality", "security", "performance", "concurrency"];
    for (const dimension of dimensions) {
      expect(COMPLETE_REVIEWER_PROMPTS[dimension]).toBeDefined();
      expect(COMPLETE_REVIEWER_PROMPTS[dimension].length).toBeGreaterThan(0);
    }
  });

  it("each prompt starts with CONTRACT", () => {
    for (const [dimension, prompt] of Object.entries(COMPLETE_REVIEWER_PROMPTS)) {
      expect(prompt.startsWith(CONTRACT.trim()), `dimension ${dimension} should start with CONTRACT`).toBe(true);
    }
  });

  it("each prompt includes the dimension-specific content", () => {
    for (const [dimension, prompt] of Object.entries(COMPLETE_REVIEWER_PROMPTS)) {
      expect(prompt).toContain(REVIEWER_PROMPTS[dimension as ReviewDimensionType]);
    }
  });

  it("matches composePrompt output exactly", () => {
    for (const dimension of Object.keys(COMPLETE_REVIEWER_PROMPTS) as ReviewDimensionType[]) {
      expect(COMPLETE_REVIEWER_PROMPTS[dimension]).toBe(composePrompt(dimension));
    }
  });
});

describe("buildHandoffProtocol", () => {
  it("includes runId in the prompt", () => {
    const prompt = buildHandoffProtocol(".omre/handoffs", "run-20260507-001");
    expect(prompt).toContain("run-20260507-001");
    expect(prompt).toContain(".omre/handoffs/run-20260507-001/");
    expect(prompt).toContain("Review Code Handoff Protocol");
  });

  it("includes handoff directory", () => {
    const prompt = buildHandoffProtocol("custom/handoffs", "run-001");
    expect(prompt).toContain("custom/handoffs/run-001/");
  });
});

describe("buildMandatoryOutputPersistence", () => {
  it("includes runId and directory", () => {
    const prompt = buildMandatoryOutputPersistence(".omre/handoffs", "run-001");
    expect(prompt).toContain("run-001");
    expect(prompt).toContain(".omre/handoffs/run-001/");
    expect(prompt).toContain("Mandatory Output Persistence");
  });

  it("requires a JSON header block", () => {
    const prompt = buildMandatoryOutputPersistence(".omre/handoffs", "run-001");
    expect(prompt).toContain("```json");
    expect(prompt).toContain("schema_version");
    expect(prompt).toContain("findings");
    expect(prompt).toContain("JSON.parse");
  });

  it("includes Markdown body section after JSON header rules", () => {
    const prompt = buildMandatoryOutputPersistence(".omre/handoffs", "run-001");
    expect(prompt).toContain("# Review Handoff");
    expect(prompt).toContain("## Metadata");
    expect(prompt).toContain("## Findings");
    expect(prompt).toContain("## Suggested Fixes");
    expect(prompt).toContain("## Open Questions");
  });
});

describe("buildReportWriterInputRule", () => {
  it("includes runId and directory", () => {
    const prompt = buildReportWriterInputRule(".omre/handoffs", "run-001");
    expect(prompt).toContain("run-001");
    expect(prompt).toContain(".omre/handoffs/run-001/*.md");
    expect(prompt).toContain("source of truth");
  });

  it("instructs reading JSON header first", () => {
    const prompt = buildReportWriterInputRule(".omre/handoffs", "run-001");
    expect(prompt).toContain("JSON header");
    expect(prompt).toContain("Read the JSON header FIRST");
  });

  it("defines handoff status values including unreadable", () => {
    const prompt = buildReportWriterInputRule(".omre/handoffs", "run-001");
    expect(prompt).toContain("completed");
    expect(prompt).toContain("blocked");
    expect(prompt).toContain("handoff_missing");
    expect(prompt).toContain("unreadable");
  });
});

describe("buildSubagentCatalog", () => {
  it("lists all reviewer subagents", () => {
    const catalog = buildSubagentCatalog();
    expect(catalog).toContain("Available Subagents");
    expect(catalog).toContain("reviewer-spec");
    expect(catalog).toContain("reviewer-quality");
    expect(catalog).toContain("reviewer-security");
    expect(catalog).toContain("reviewer-performance");
    expect(catalog).toContain("reviewer-concurrency");
  });

  it("lists all coordination subagents", () => {
    const catalog = buildSubagentCatalog();
    expect(catalog).toContain("slice-planner");
    expect(catalog).toContain("slice-plan-validator");
    expect(catalog).toContain("result-validator");
    expect(catalog).toContain("slice-arbiter");
    expect(catalog).toContain("global-arbiter");
    expect(catalog).toContain("report-writer");
  });

  it("does not include full role prompts", () => {
    const catalog = buildSubagentCatalog();
    expect(catalog).not.toContain("You are the diff slice planner");
    expect(catalog).not.toContain("You are the review result validator");
    expect(catalog).not.toContain("You are the slice arbiter");
    expect(catalog).not.toContain("You are the global arbiter");
    expect(catalog).not.toContain("You are the review-code report writer");
  });
});

describe("SLICE_ARBITER_PROMPT", () => {
  it("includes rejection reason enum", () => {
    expect(SLICE_ARBITER_PROMPT).toContain("duplicate");
    expect(SLICE_ARBITER_PROMPT).toContain("weak-evidence");
    expect(SLICE_ARBITER_PROMPT).toContain("speculative");
    expect(SLICE_ARBITER_PROMPT).toContain("out-of-scope");
    expect(SLICE_ARBITER_PROMPT).toContain("contradicted-by-code");
  });

  it("forbids free-form rejection reasons", () => {
    expect(SLICE_ARBITER_PROMPT).toContain("Free-form rejection reasons are forbidden");
  });
});

describe("GLOBAL_ARBITER_PROMPT", () => {
  it("includes rejection reason enum", () => {
    expect(GLOBAL_ARBITER_PROMPT).toContain("duplicate");
    expect(GLOBAL_ARBITER_PROMPT).toContain("weak-evidence");
    expect(GLOBAL_ARBITER_PROMPT).toContain("speculative");
    expect(GLOBAL_ARBITER_PROMPT).toContain("out-of-scope");
    expect(GLOBAL_ARBITER_PROMPT).toContain("contradicted-by-code");
  });

  it("forbids free-form rejection reasons", () => {
    expect(GLOBAL_ARBITER_PROMPT).toContain("Free-form rejection reasons are forbidden");
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CHAT_JSON_CONTRACT,
  FILE_HANDOFF_CONTRACT,
  GLOBAL_ARBITER_PROMPT,
  REVIEWER_PROMPTS,
  COMPLETE_REVIEWER_PROMPTS,
  RESULT_VALIDATOR_PROMPT,
  STATIC_HANDOFF_PROTOCOL,
  SLICE_ARBITER_PROMPT,
  SLICE_PLANNER_PROMPT,
  SLICE_PLAN_VALIDATOR_PROMPT,
  composePrompt,
  buildHandoffRuntime,
  buildReportWriterInputRule,
  buildSubagentCatalog,
} from "../../src/agents/prompts.js";
import { SLICE_TYPE_VALUES } from "../../src/agents/schemas.js";
import type { ReviewDimensionType } from "../../src/config/schema.js";

describe("CHAT_JSON_CONTRACT (coordinator-facing, chat-only)", () => {
  it("contains the strict-JSON base rules", () => {
    expect(CHAT_JSON_CONTRACT).toContain("Output strict JSON only when asked for machine-readable results");
    expect(CHAT_JSON_CONTRACT).toContain("Never fabricate issues");
    expect(CHAT_JSON_CONTRACT).toContain("evidence-backed");
  });

  it("forbids markdown fences and outside-JSON prose", () => {
    expect(CHAT_JSON_CONTRACT).toContain("Do not wrap JSON in markdown fences");
    expect(CHAT_JSON_CONTRACT).toContain("Do not emit commentary outside JSON");
  });
});

describe("FILE_HANDOFF_CONTRACT (reviewer-facing, file-primary)", () => {
  it("contains the strict-JSON base rules", () => {
    expect(FILE_HANDOFF_CONTRACT).toContain("Output strict JSON only when asked for machine-readable results");
    expect(FILE_HANDOFF_CONTRACT).toContain("Never fabricate issues");
    expect(FILE_HANDOFF_CONTRACT).toContain("evidence-backed");
  });

  it("[L1 fix] does NOT forbid markdown fences (the handoff file requires one)", () => {
    expect(FILE_HANDOFF_CONTRACT).not.toMatch(/Do not wrap JSON in markdown fences/);
  });

  it("[L1 fix] does NOT forbid outside-JSON prose (the handoff file has a Markdown body and a chat receipt)", () => {
    expect(FILE_HANDOFF_CONTRACT).not.toMatch(/Do not emit commentary outside JSON/);
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

  it("does not include FILE_HANDOFF_CONTRACT in individual prompts", () => {
    for (const [dimension, prompt] of Object.entries(REVIEWER_PROMPTS)) {
      expect(prompt, `dimension ${dimension} should not contain FILE_HANDOFF_CONTRACT`).not.toContain(FILE_HANDOFF_CONTRACT.trim());
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
  it("prepends FILE_HANDOFF_CONTRACT to each dimension prompt", () => {
    const dimensions: ReviewDimensionType[] = ["spec", "quality", "security", "performance", "concurrency"];
    for (const dimension of dimensions) {
      const composed = composePrompt(dimension);
      expect(composed.startsWith(FILE_HANDOFF_CONTRACT.trim()), `dimension ${dimension} should start with FILE_HANDOFF_CONTRACT`).toBe(true);
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

  it("each prompt starts with FILE_HANDOFF_CONTRACT (reviewers write file with json fence)", () => {
    for (const [dimension, prompt] of Object.entries(COMPLETE_REVIEWER_PROMPTS)) {
      expect(prompt.startsWith(FILE_HANDOFF_CONTRACT.trim()), `dimension ${dimension} should start with FILE_HANDOFF_CONTRACT`).toBe(true);
    }
  });

  it("[L1 fix] no reviewer prompt forbids markdown fences", () => {
    for (const [dim, p] of Object.entries(COMPLETE_REVIEWER_PROMPTS)) {
      expect(p, `dimension=${dim}`).not.toMatch(/Do not wrap JSON in markdown fences/);
    }
  });

  it("[L1 fix] no reviewer prompt forbids outside-JSON prose", () => {
    for (const [dim, p] of Object.entries(COMPLETE_REVIEWER_PROMPTS)) {
      expect(p, `dimension=${dim}`).not.toMatch(/Do not emit commentary outside JSON/);
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

describe("buildHandoffRuntime (per-run runtime stanza)", () => {
  it("includes runId and handoff directory", () => {
    const prompt = buildHandoffRuntime(".omre/handoffs", "run-20260507-001");
    expect(prompt).toContain("run-20260507-001");
    expect(prompt).toContain(".omre/handoffs/run-20260507-001/");
    expect(prompt).toContain("Review Code Handoff Runtime");
  });

  it("includes custom handoff directory", () => {
    const prompt = buildHandoffRuntime("custom/handoffs", "run-001");
    expect(prompt).toContain("custom/handoffs/run-001/");
  });
});

describe("STATIC_HANDOFF_PROTOCOL (channel/format rules)", () => {
  it("contains protocol header", () => {
    expect(STATIC_HANDOFF_PROTOCOL).toContain("Review Code Handoff Protocol");
  });

  it("mandates omre_write_handoff tool usage", () => {
    expect(STATIC_HANDOFF_PROTOCOL).toContain("omre_write_handoff");
    expect(STATIC_HANDOFF_PROTOCOL).toMatch(/MUST|must/);
  });

  it("does not contain file naming convention for direct writes", () => {
    expect(STATIC_HANDOFF_PROTOCOL).not.toContain("File naming convention");
  });

  it("[L1.5 fix] does not say the chat reply must 'contain only' the receipt block AND 'also include' a fallback fence", () => {
    const hasContainOnly = /contain\s+only/i.test(STATIC_HANDOFF_PROTOCOL);
    const hasAlsoInclude = /MUST also include/i.test(STATIC_HANDOFF_PROTOCOL);
    expect(hasContainOnly && hasAlsoInclude).toBe(false);
  });

  it("[L1.5 fix] removes the subagent-facing chat-fallback instruction (recovery is the orchestrator's job)", () => {
    expect(STATIC_HANDOFF_PROTOCOL).not.toMatch(/Chat Fallback/i);
    expect(STATIC_HANDOFF_PROTOCOL).not.toMatch(/include the complete handoff JSON\s+header inside a/i);
  });

  it("[L1.5 fix] explicitly forbids the subagent from including a json fence in chat", () => {
    expect(STATIC_HANDOFF_PROTOCOL).toMatch(/never include[^.]*json fence[^.]*chat/i);
  });

  it("[N3] tells reviewers to pass runId when calling omre_write_handoff", () => {
    const paragraphs = STATIC_HANDOFF_PROTOCOL.split(/\n\s*\n/);
    expect(
      paragraphs.some((paragraph) =>
        /omre_write_handoff/.test(paragraph) && /runId/.test(paragraph)
      )
    ).toBe(true);
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

  it("[step 20] is a one-liner without legacy section headers", () => {
    const catalog = buildSubagentCatalog();
    expect(catalog).not.toContain("### Reviewer Subagents");
    expect(catalog).not.toContain("### Coordination Subagents");
  });
});

describe("SLICE_PLANNER_PROMPT", () => {
  it("[N1] renders every canonical slice_type value", () => {
    for (const sliceType of SLICE_TYPE_VALUES) {
      expect(SLICE_PLANNER_PROMPT).toContain(sliceType);
    }
    expect(SLICE_PLANNER_PROMPT).toContain(SLICE_TYPE_VALUES.join(", "));
  });

  it("[N1] derives the prose allowlist from SLICE_TYPE_VALUES instead of a literal duplicate", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/agents/prompts.ts"), "utf8");
    expect(source).not.toContain(`Allowed slice_type values: ${SLICE_TYPE_VALUES.join(", ")}.`);
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

describe("Coordinator prompt snapshots", () => {
  it("SLICE_PLANNER_PROMPT remains stable", () => {
    expect(SLICE_PLANNER_PROMPT).toMatchSnapshot();
  });

  it("SLICE_PLAN_VALIDATOR_PROMPT remains stable", () => {
    expect(SLICE_PLAN_VALIDATOR_PROMPT).toMatchSnapshot();
  });

  it("RESULT_VALIDATOR_PROMPT remains stable", () => {
    expect(RESULT_VALIDATOR_PROMPT).toMatchSnapshot();
  });

  it("SLICE_ARBITER_PROMPT remains stable", () => {
    expect(SLICE_ARBITER_PROMPT).toMatchSnapshot();
  });

  it("GLOBAL_ARBITER_PROMPT remains stable", () => {
    expect(GLOBAL_ARBITER_PROMPT).toMatchSnapshot();
  });
});

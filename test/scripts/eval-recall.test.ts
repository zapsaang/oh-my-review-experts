import { describe, it, expect } from "vitest";
import { z } from "zod";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFindingSchema } from "../../src/memory/schema.js";
import { searchMemory } from "../../src/memory/search.js";
import { rankMemoryHits } from "../../src/memory/ranking.js";
import { buildMemoryContextPack } from "../../src/memory/context-pack.js";
import {
  loadFindings,
  loadScenarios,
  evaluateScenario,
  aggregate,
  EvalScenarioSchema,
  type EvalScenario,
} from "../../scripts/eval-recall.js";
import { makeFinding } from "../fixtures/recall-eval/helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixtureDir = join(__dirname, "../fixtures/recall-eval");
const findings: import("../../src/memory/schema.js").MemoryFinding[] = JSON.parse(
  readFileSync(join(fixtureDir, "findings.json"), "utf-8"),
);
const scenarios: EvalScenario[] = JSON.parse(
  readFileSync(join(fixtureDir, "scenarios.json"), "utf-8"),
);

function computePrecisionAtK(
  ranked: import("../../src/memory/ranking.js").RankedMemoryHit[],
  relevantIds: Set<string>,
  k: number,
): number {
  const topK = ranked.slice(0, k);
  if (topK.length === 0) return 0;
  const relevantInTopK = topK.filter((h) => relevantIds.has(h.finding.id)).length;
  return relevantInTopK / k;
}

function computeRecallAtK(
  ranked: import("../../src/memory/ranking.js").RankedMemoryHit[],
  relevantIds: Set<string>,
  k: number,
): number {
  if (relevantIds.size === 0) return 0;
  const topK = ranked.slice(0, k);
  const relevantInTopK = topK.filter((h) => relevantIds.has(h.finding.id)).length;
  return relevantInTopK / relevantIds.size;
}

function computeMrr(
  ranked: import("../../src/memory/ranking.js").RankedMemoryHit[],
  relevantIds: Set<string>,
): number {
  let answerRank = 0;
  for (const hit of ranked) {
    const relevant = relevantIds.has(hit.finding.id);
    if (hit.regressionCandidate && !relevant) {
      continue;
    }
    answerRank++;
    if (relevant) {
      return 1 / answerRank;
    }
  }
  return 0;
}

function computeContextPackRecall(
  ranked: import("../../src/memory/ranking.js").RankedMemoryHit[],
  relevantIds: Set<string>,
): number {
  if (relevantIds.size === 0) return 0;
  const pack = buildMemoryContextPack({ hits: ranked });
  const includedRelevant = pack.includedIds.filter((id) => relevantIds.has(id)).length;
  return includedRelevant / relevantIds.size;
}

describe("eval-recall fixtures", () => {
  it("findings.json schema-valid", () => {
    expect(() => z.array(MemoryFindingSchema).parse(findings)).not.toThrow();
  });

  it("scenarios.json schema-valid", () => {
    for (const scenario of scenarios) {
      expect(() => EvalScenarioSchema.parse(scenario)).not.toThrow();
    }
  });

  it("ground-truth referential integrity", () => {
    const findingIds = new Set(findings.map((f) => f.id));
    for (const scenario of scenarios) {
      for (const id of scenario.relevantFindingIds) {
        expect(findingIds.has(id)).toBe(true);
      }
    }
  });

  it("makeFinding() validity", () => {
    const finding = makeFinding();
    expect(() => MemoryFindingSchema.parse(finding)).not.toThrow();
  });
});

describe("eval-recall metrics", () => {
  it("precision@k bounded: 0 <= p <= 1", () => {
    const scenario = scenarios.find((s) => s.id === "sc-01-high-relevance")!;
    const result = searchMemory({
      query: scenario.query,
      reviewer: scenario.reviewer,
      findings,
      paths: scenario.slicePaths,
      similarityThreshold: 0.0,
    });
    const ranked = rankMemoryHits({ hits: result.hits, reviewer: scenario.reviewer });
    const relevantIds = new Set(scenario.relevantFindingIds);

    const metrics = evaluateScenario(scenario, findings, 0.0);
    expect(metrics.precisionAt1).toBe(computePrecisionAtK(ranked, relevantIds, 1));
    expect(metrics.precisionAt1).toBeGreaterThanOrEqual(0);
    expect(metrics.precisionAt1).toBeLessThanOrEqual(1);
  });

  it("recall@k bounded: 0 <= r <= 1", () => {
    const scenario = scenarios.find((s) => s.id === "sc-01-high-relevance")!;
    const result = searchMemory({
      query: scenario.query,
      reviewer: scenario.reviewer,
      findings,
      paths: scenario.slicePaths,
      similarityThreshold: 0.0,
    });
    const ranked = rankMemoryHits({ hits: result.hits, reviewer: scenario.reviewer });
    const relevantIds = new Set(scenario.relevantFindingIds);

    const metrics = evaluateScenario(scenario, findings, 0.0);
    expect(metrics.recallAt1).toBe(computeRecallAtK(ranked, relevantIds, 1));
    expect(metrics.recallAt1).toBeGreaterThanOrEqual(0);
    expect(metrics.recallAt1).toBeLessThanOrEqual(1);
  });

  it("MRR correct", () => {
    // Create a custom finding that outranks the relevant one so first relevant is at rank 2
    const customFinding = makeFinding({
      id: "mem_00000000000000ff",
      severity: "critical",
      status: "open",
      reviewer: "security",
      searchable: { redactedText: "tenant isolation", tokens: ["tenant", "isolation"] },
      locations: [{ path: "src/tenants.ts", line: 1 }],
    });
    const scenario = scenarios.find((s) => s.id === "sc-01-high-relevance")!;
    const allFindings = [...findings, customFinding];
    const result = searchMemory({
      query: scenario.query,
      reviewer: scenario.reviewer,
      findings: allFindings,
      paths: scenario.slicePaths,
      similarityThreshold: 0.0,
    });
    const ranked = rankMemoryHits({ hits: result.hits, reviewer: scenario.reviewer });
    const relevantIds = new Set(scenario.relevantFindingIds);

    const metrics = evaluateScenario(scenario, allFindings, 0.0);
    expect(metrics.mrr).toBe(0.5);
  });

  it("zero-relevant scenario", () => {
    const scenario = scenarios.find((s) => s.id === "sc-03-zero-relevant")!;

    const metrics = evaluateScenario(scenario, findings, 0.0);
    expect(metrics.precisionAt1).toBe(0);
    expect(metrics.precisionAt3).toBe(0);
    expect(metrics.precisionAt6).toBe(0);
    expect(metrics.recallAt1).toBe(0);
    expect(metrics.recallAt3).toBe(0);
    expect(metrics.recallAt6).toBe(0);
    expect(metrics.mrr).toBe(0);
    expect(Number.isNaN(metrics.mrr)).toBe(false);
  });

  it("macro-average", () => {
    const scenario1 = scenarios.find((s) => s.id === "sc-01-high-relevance")!;
    const scenario2 = scenarios.find((s) => s.id === "sc-03-zero-relevant")!;

    const metrics1 = evaluateScenario(scenario1, findings, 0.0);
    const metrics2 = evaluateScenario(scenario2, findings, 0.0);

    const agg = aggregate([metrics1, metrics2]);

    // macro-average is the arithmetic mean; this is a definition, not a tautology.
    expect(agg.meanPrecisionAt1).toBe((metrics1.precisionAt1 + metrics2.precisionAt1) / 2);
    expect(agg.meanRecallAt1).toBe((metrics1.recallAt1 + metrics2.recallAt1) / 2);
    expect(agg.meanMrr).toBe((metrics1.mrr + metrics2.mrr) / 2);
  });

  it("contextPackRecall <= recall@6 invariant", () => {
    const scenario = scenarios.find((s) => s.id === "sc-01-high-relevance")!;
    const result = searchMemory({
      query: scenario.query,
      reviewer: scenario.reviewer,
      findings,
      paths: scenario.slicePaths,
      similarityThreshold: 0.0,
    });
    const ranked = rankMemoryHits({ hits: result.hits, reviewer: scenario.reviewer });
    const relevantIds = new Set(scenario.relevantFindingIds);

    const metrics = evaluateScenario(scenario, findings, 0.0);
    const contextPackRecall = computeContextPackRecall(ranked, relevantIds);
    expect(contextPackRecall).toBeLessThanOrEqual(metrics.recallAt6);
  });
});

describe("eval-recall production", () => {
  it("empty hits pack", () => {
    const pack = buildMemoryContextPack({ hits: [] });
    expect(pack.includedIds).toEqual([]);
    expect(pack.truncated).toBe(false);
  });
  it("MRR skips fixed regression candidates ranked above relevant", () => {
    const fixedFinding = makeFinding({
      id: "mem_00000000000000ff",
      status: "fixed",
      severity: "critical",
      searchable: { redactedText: "tenant isolation", tokens: ["tenant", "isolation"] },
    });
    const scenario = scenarios.find((s) => s.id === "sc-01-high-relevance")!;
    const allFindings = [...findings, fixedFinding];
    const metrics = evaluateScenario(scenario, allFindings, 0.0);
    expect(metrics.mrr).toBe(1.0);
  });

  it("pack.truncated: char budget binding", () => {
    const hugeFinding = makeFinding({
      id: "mem_00000000000000ff",
      searchable: { redactedText: "x".repeat(10_000), tokens: ["test"] },
    });
    const scenario: EvalScenario = {
      id: "sc-char-bound",
      description: "char budget binding test",
      query: "test",
      reviewer: "security",
      slicePaths: [],
      relevantFindingIds: [hugeFinding.id],
    };
    const metrics = evaluateScenario(scenario, [hugeFinding], 0.0);
    expect(metrics.packTruncated).toBe(true);
    expect(metrics.packBudgetBinding).toBe("char");
  });

  it("pack.truncated: item budget binding", () => {
    const f1 = makeFinding({ id: "mem_00000000000000f1", searchable: { redactedText: "a", tokens: ["test"] } });
    const f2 = makeFinding({ id: "mem_00000000000000f2", searchable: { redactedText: "a", tokens: ["test"] } });
    const f3 = makeFinding({ id: "mem_00000000000000f3", searchable: { redactedText: "a", tokens: ["test"] } });
    const f4 = makeFinding({ id: "mem_00000000000000f4", searchable: { redactedText: "a", tokens: ["test"] } });
    const f5 = makeFinding({ id: "mem_00000000000000f5", searchable: { redactedText: "a", tokens: ["test"] } });
    const f6 = makeFinding({ id: "mem_00000000000000f6", searchable: { redactedText: "a", tokens: ["test"] } });
    const f7 = makeFinding({ id: "mem_00000000000000f7", searchable: { redactedText: "a", tokens: ["test"] } });
    const scenario: EvalScenario = {
      id: "sc-item-bound",
      description: "item budget binding test",
      query: "test",
      reviewer: "security",
      slicePaths: [],
      relevantFindingIds: [f1.id],
    };
    const allFindings = [f1, f2, f3, f4, f5, f6, f7];
    const metrics = evaluateScenario(scenario, allFindings, 0.0);
    expect(metrics.packTruncated).toBe(true);
    expect(metrics.packBudgetBinding).toBe("item");
  });

  it("makeFinding() rejects invalid overrides", () => {
    expect(() => makeFinding({ id: "bad" } as Partial<import("../../src/memory/schema.js").MemoryFinding>)).toThrow();
    expect(() => makeFinding({ status: "not-a-status" } as unknown as Partial<import("../../src/memory/schema.js").MemoryFinding>)).toThrow();
  });

  it("loadScenarios() validates referential integrity", () => {
    const allFindings = loadFindings(fixtureDir);
    expect(() => loadScenarios(fixtureDir, allFindings)).not.toThrow();
  });

  it("loadScenarios() rejects unknown finding id references", () => {
    const allFindings = loadFindings(fixtureDir);
    const tmpDir = join(tmpdir(), `omre-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const badScenario = { ...scenarios[0], relevantFindingIds: ["nonexistent-id"] };
    writeFileSync(join(tmpDir, "scenarios.json"), JSON.stringify([badScenario]));
    expect(() => loadScenarios(tmpDir, allFindings)).toThrow(/references unknown finding id/);
    rmSync(tmpDir, { recursive: true, force: true });
  });

});

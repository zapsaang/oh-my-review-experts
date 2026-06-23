import { z } from "zod";
import { MemoryFindingSchema, type MemoryFinding } from "../src/memory/schema.js";
import { searchMemory } from "../src/memory/search.js";
import { rankMemoryHits, type RankedMemoryHit } from "../src/memory/ranking.js";
import { buildMemoryContextPack } from "../src/memory/context-pack.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Table from "cli-table3";

export const K_VALUES = [1, 3, 6] as const;

const DEFAULT_THRESHOLD = 0.75;

export const EvalScenarioSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  query: z.string().min(1),
  reviewer: z.string().min(1),
  slicePaths: z.array(z.string()),
  relevantFindingIds: z.array(z.string()),
});

export type EvalScenario = z.infer<typeof EvalScenarioSchema>;

export interface ScenarioMetrics {
  scenarioId: string;
  precisionAt1: number;
  precisionAt3: number;
  precisionAt6: number;
  recallAt1: number;
  recallAt3: number;
  recallAt6: number;
  mrr: number;
  contextPackRecall: number;
  relevantCount: number;
  top6RelevantCount: number;
  packTruncated: boolean;
  packBudgetBinding: "none" | "char" | "item";
}

export interface AggregateMetrics {
  meanPrecisionAt1: number;
  meanPrecisionAt3: number;
  meanPrecisionAt6: number;
  meanRecallAt1: number;
  meanRecallAt3: number;
  meanRecallAt6: number;
  meanMrr: number;
  meanContextPackRecall: number;
  scenarioCount: number;
  anyPackTruncated: boolean;
  charBudgetBoundCount: number;
  itemBudgetBoundCount: number;
}

export function loadFindings(fixtureDir: string): MemoryFinding[] {
  const data: unknown = JSON.parse(readFileSync(join(fixtureDir, "findings.json"), "utf-8"));
  return z.array(MemoryFindingSchema).parse(data);
}

export function loadScenarios(fixtureDir: string, findings: readonly MemoryFinding[]): EvalScenario[] {
  const data: unknown = JSON.parse(readFileSync(join(fixtureDir, "scenarios.json"), "utf-8"));
  const scenarios = z.array(EvalScenarioSchema).parse(data);
  const findingIds = new Set(findings.map((f) => f.id));
  for (const scenario of scenarios) {
    for (const id of scenario.relevantFindingIds) {
      if (!findingIds.has(id)) {
        throw new Error(
          `Scenario "${scenario.id}" references unknown finding id "${id}". ` +
          `Check that all relevantFindingIds exist in findings.json.`
        );
      }
    }
  }
  return scenarios;
}

export function evaluateScenario(
  scenario: EvalScenario,
  findings: MemoryFinding[],
  threshold: number,
): ScenarioMetrics {
  const result = searchMemory({
    findings,
    query: scenario.query,
    reviewer: scenario.reviewer,
    paths: scenario.slicePaths,
    similarityThreshold: threshold,
  });
  const ranked = rankMemoryHits({ hits: result.hits, reviewer: scenario.reviewer });
  const relevantIds = new Set(scenario.relevantFindingIds);
  const precisionAtK: Record<(typeof K_VALUES)[number], number> = { 1: 0, 3: 0, 6: 0 };
  const recallAtK: Record<(typeof K_VALUES)[number], number> = { 1: 0, 3: 0, 6: 0 };

  for (const k of K_VALUES) {
    precisionAtK[k] = computePrecisionAtK(ranked, relevantIds, k);
    recallAtK[k] = computeRecallAtK(ranked, relevantIds, k);
  }

  const pack = buildMemoryContextPack({ hits: ranked });
  const includedRelevantCount = pack.includedIds.filter((id) => relevantIds.has(id)).length;
  const contextPackRecall = relevantIds.size > 0 ? includedRelevantCount / relevantIds.size : 0;

  return {
    scenarioId: scenario.id,
    precisionAt1: precisionAtK[1],
    precisionAt3: precisionAtK[3],
    precisionAt6: precisionAtK[6],
    recallAt1: recallAtK[1],
    recallAt3: recallAtK[3],
    recallAt6: recallAtK[6],
    mrr: computeMrr(ranked, relevantIds),
    contextPackRecall,
    relevantCount: relevantIds.size,
    top6RelevantCount: countRelevantHits(ranked.slice(0, 6), relevantIds),
    packTruncated: pack.truncated,
    packBudgetBinding: pack.truncated && pack.includedIds.length < 6 ? "char" : pack.truncated ? "item" : "none",
  };
}

export function aggregate(
  metrics: ScenarioMetrics[],
): AggregateMetrics {
  return {
    meanPrecisionAt1: mean(metrics, (metric) => metric.precisionAt1),
    meanPrecisionAt3: mean(metrics, (metric) => metric.precisionAt3),
    meanPrecisionAt6: mean(metrics, (metric) => metric.precisionAt6),
    meanRecallAt1: mean(metrics, (metric) => metric.recallAt1),
    meanRecallAt3: mean(metrics, (metric) => metric.recallAt3),
    meanRecallAt6: mean(metrics, (metric) => metric.recallAt6),
    meanMrr: mean(metrics, (metric) => metric.mrr),
    meanContextPackRecall: mean(metrics, (metric) => metric.contextPackRecall),
    scenarioCount: metrics.length,
    anyPackTruncated: metrics.some((m) => m.packTruncated),
    charBudgetBoundCount: metrics.filter((m) => m.packBudgetBinding === "char").length,
    itemBudgetBoundCount: metrics.filter((m) => m.packBudgetBinding === "item").length,
  };
}

export function renderTable(agg: AggregateMetrics): string {
  const table = new Table({ head: ["Metric", "Value"] });

  table.push(
    ["Precision@1", agg.meanPrecisionAt1.toFixed(3)],
    ["Precision@3", agg.meanPrecisionAt3.toFixed(3)],
    ["Precision@6", agg.meanPrecisionAt6.toFixed(3)],
    ["Recall@1", agg.meanRecallAt1.toFixed(3)],
    ["Recall@3", agg.meanRecallAt3.toFixed(3)],
    ["Recall@6", agg.meanRecallAt6.toFixed(3)],
    ["MRR", agg.meanMrr.toFixed(3)],
    ["ContextPackRecall", agg.meanContextPackRecall.toFixed(3)],
    ["Scenarios", agg.scenarioCount.toString()],
    ["AnyPackTruncated", agg.anyPackTruncated.toString()],
    ["CharBudgetBoundCount", agg.charBudgetBoundCount.toString()],
    ["ItemBudgetBoundCount", agg.itemBudgetBoundCount.toString()],
  );

  return table.toString();
}

export function main(): void {
  const thresholdArg = process.argv.find((arg) => arg.startsWith("--threshold="));
  let threshold: number;
  if (thresholdArg === undefined) {
    threshold = DEFAULT_THRESHOLD;
  } else {
    const raw = thresholdArg.slice("--threshold=".length).trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      console.error(`Invalid --threshold value: "${raw}". Must be a finite number in [0, 1].`);
      process.exit(1);
    }
    threshold = parsed;
  }
  const jsonOutput = process.argv.includes("--json");
  const fixtureDir = fileURLToPath(new URL("../test/fixtures/recall-eval/", import.meta.url));
  const findings = loadFindings(fixtureDir);
  const scenarios = loadScenarios(fixtureDir, findings);
  const metrics = scenarios.map((scenario) => evaluateScenario(scenario, findings, threshold));
  const aggregateMetrics = aggregate(metrics);

  if (jsonOutput) {
    console.log(JSON.stringify(aggregateMetrics, null, 2));
    return;
  }

  console.log(renderTable(aggregateMetrics));
}

function computePrecisionAtK(
  ranked: readonly RankedMemoryHit[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (k === 0 || relevantIds.size === 0) {
    return 0;
  }

  return countRelevantHits(ranked.slice(0, k), relevantIds) / k;
}

function computeRecallAtK(
  ranked: readonly RankedMemoryHit[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (relevantIds.size === 0) {
    return 0;
  }

  return countRelevantHits(ranked.slice(0, k), relevantIds) / relevantIds.size;
}

function computeMrr(ranked: readonly RankedMemoryHit[], relevantIds: ReadonlySet<string>): number {
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

function countRelevantHits(hits: readonly RankedMemoryHit[], relevantIds: ReadonlySet<string>): number {
  return hits.filter((hit) => relevantIds.has(hit.finding.id)).length;
}

function mean(metrics: readonly ScenarioMetrics[], selector: (metric: ScenarioMetrics) => number): number {
  if (metrics.length === 0) {
    return 0;
  }

  return metrics.reduce((sum, metric) => sum + selector(metric), 0) / metrics.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

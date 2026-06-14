import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryConfigSchema, type MemoryConfig } from "../../src/memory/config.js";
import { runIndexLatest, type IndexLatestResult } from "../../src/memory/indexing.js";
import { ensureMemoryDirs, resolveMemoryPaths } from "../../src/memory/paths.js";
import {
  autoIndexAfterReview,
  buildSearchQuery,
  checkAutoCompactThreshold,
  retrieveMemoryContext,
  type RetrieveMemoryContextInput,
} from "../../src/memory/pipeline.js";
import type { MemoryFinding, MemoryManifest, RelatedIndex } from "../../src/memory/schema.js";
import * as memoryStore from "../../src/memory/store.js";

vi.mock("../../src/memory/indexing.js", () => ({
  runIndexLatest: vi.fn((): IndexLatestResult => ({
    runId: "mock-run",
    rawFindings: 0,
    normalizedFindings: 0,
    existingFindings: 0,
    eventsGenerated: 0,
    findingsDeduplicated: 0,
    dryRun: false,
  })),
}));

vi.mock("../../src/memory/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/store.js")>();
  return {
    ...actual,
    readMaterializedState: vi.fn(actual.readMaterializedState),
  };
});

const timestamp = "2026-06-01T12:00:00.000Z";
const tempDirs: string[] = [];
const runIndexLatestMock = vi.mocked(runIndexLatest);

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-pipeline-"));
  tempDirs.push(dir);
  return dir;
}

function memoryConfigWith(options: {
  enabled?: boolean;
  directory?: string;
  retrieval?: Partial<MemoryConfig["retrieval"]>;
  compaction?: Partial<MemoryConfig["compaction"]>;
} = {}): MemoryConfig {
  const base = MemoryConfigSchema.parse({});

  return {
    ...base,
    enabled: options.enabled ?? base.enabled,
    directory: options.directory ?? base.directory,
    retrieval: {
      ...base.retrieval,
      enabled: true,
      ...options.retrieval,
    },
    compaction: {
      ...base.compaction,
      ...options.compaction,
    },
  };
}

function retrievalInput(
  repoRoot: string,
  memoryConfig: MemoryConfig,
  overrides: Partial<RetrieveMemoryContextInput> = {},
): RetrieveMemoryContextInput {
  return {
    repoRoot,
    reviewer: "omre-reviewer-security",
    slicePaths: ["src/auth.ts"],
    diffSummary: "tenant isolation",
    userGuidance: "",
    memoryConfig,
    withMemory: true,
    noMemory: false,
    ...overrides,
  };
}

function validFinding(overrides: Partial<MemoryFinding> = {}): MemoryFinding {
  const finding = {
    schemaVersion: 1,
    id: "mem_1111111111111111",
    fingerprint: "fingerprintvalue1",
    repo: {
      rootHash: "repo1234567890abcd",
      packagePath: ".",
    },
    origin: {
      runId: "run-pipeline",
      sourceType: "report",
      sourcePath: ".omre/reports/latest.json",
      createdAt: timestamp,
    },
    reviewer: "security",
    severity: "high",
    status: "open",
    category: "authz",
    title: "Missing tenant isolation",
    problem: "Tenant records are queried without checking the caller tenant.",
    evidence: "db.query('select * from tenants')",
    locations: [{ path: "src/auth.ts", line: 42 }],
    occurrence: {
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      count: 1,
      runIds: ["run-pipeline"],
    },
    searchable: {
      redactedText: "tenant isolation",
      tokens: ["tenant", "isolation"],
    },
    metadata: {
      evidenceTruncated: false,
      problemTruncated: false,
      recommendationTruncated: false,
      sourceMalformed: false,
    },
    tags: [],
    contentHash: "contenthashvalue1",
  } satisfies MemoryFinding;

  return { ...finding, ...overrides };
}

function validManifest(overrides: Partial<MemoryManifest> = {}): MemoryManifest {
  const manifest = {
    schemaVersion: 1,
    eventSchemaVersion: 1,
    viewSchemaVersion: 1,
    lastRebuiltAt: timestamp,
    materializedHash: "materializedhash1",
    relatedIndexHash: "relatedindexhash1",
    includedEventFiles: [],
    compactedInputSegments: [],
    gcSummary: {
      deletedRawSegments: 0,
      deletedTmpFiles: 0,
      deletedQuarantineFiles: 0,
    },
    quarantine: [],
  } satisfies MemoryManifest;

  return { ...manifest, ...overrides };
}

function emptyRelatedIndex(): RelatedIndex {
  return {
    schemaVersion: 1,
    generatedAt: timestamp,
    relations: [],
    byFindingId: {},
  };
}

function writeMemoryState(repoRoot: string, memoryConfig: MemoryConfig, findings: MemoryFinding[]): void {
  const paths = resolveMemoryPaths(repoRoot, memoryConfig.directory);
  ensureMemoryDirs(paths);
  memoryStore.writeMaterializedState(paths, {
    findings,
    manifest: validManifest(),
    relatedIndex: emptyRelatedIndex(),
  });
}

function writeSegment(repoRoot: string, memoryConfig: MemoryConfig, fileName: string, ageHours = 0): string {
  const paths = resolveMemoryPaths(repoRoot, memoryConfig.directory);
  ensureMemoryDirs(paths);
  const segmentPath = path.join(paths.segmentsDir, fileName);
  fs.writeFileSync(segmentPath, "{}\n", "utf8");

  if (ageHours > 0) {
    const mtime = new Date(Date.now() - ageHours * 60 * 60 * 1000);
    fs.utimesSync(segmentPath, mtime, mtime);
  }

  return segmentPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildSearchQuery", () => {
  it("strips markdown fences, normalizes whitespace, dedupes stably, caps tokens, and excludes slice paths", () => {
    const diffTokens = Array.from({ length: 90 }, (_unused, index) => `d${index}`).join(" ");
    const guidanceTokens = ["d0", "d1", ...Array.from({ length: 90 }, (_unused, index) => `g${index}`)].join(" ");
    const query = buildSearchQuery(retrievalInput("/tmp/repo", memoryConfigWith(), {
      diffSummary: `\`\`\`ts\n${diffTokens}\n\`\`\``,
      userGuidance: guidanceTokens,
      slicePaths: ["src/slice_path_secret.ts"],
    }));

    expect(query).toHaveLength(75);
    expect(query?.slice(0, 3)).toEqual(["d0", "d1", "d2"]);
    expect(new Set(query).size).toBe(query?.length);
    expect(query).not.toContain("ts");
    expect(query).not.toContain("src");
    expect(query).not.toContain("slice_path_secret");
    expect(query?.filter((token) => token === "d0")).toHaveLength(1);
  });

  it("uses only the first 200 normalized characters from diffSummary and userGuidance", () => {
    const longDiff = `${"prefix ".repeat(40)}diff_tail_token`;
    const longGuidance = `${"focus ".repeat(40)}guidance_tail_token`;
    const query = buildSearchQuery(retrievalInput("/tmp/repo", memoryConfigWith(), {
      diffSummary: longDiff,
      userGuidance: longGuidance,
    }));

    expect(query).toContain("prefix");
    expect(query).toContain("focus");
    expect(query).not.toContain("diff_tail_token");
    expect(query).not.toContain("guidance_tail_token");
  });

  it("returns undefined for empty token output without using slicePaths as keyword fallback", () => {
    const query = buildSearchQuery(retrievalInput("/tmp/repo", memoryConfigWith(), {
      diffSummary: "租户隔离",
      userGuidance: "只检查认证",
      slicePaths: ["src/auth.ts"],
    }));

    expect(query).toBeUndefined();
  });
});

describe("retrieveMemoryContext", () => {
  it("warns and returns undefined when materialized state reading fails", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(memoryStore.readMaterializedState).mockImplementationOnce(() => {
      throw new Error("corrupt manifest");
    });

    const result = retrieveMemoryContext(retrievalInput(repoRoot, memoryConfig));

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("memory: failed to read materialized state, skipping retrieval: corrupt manifest");
  });

  it("returns undefined instead of throwing when the materialized manifest is corrupt", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith();
    const paths = resolveMemoryPaths(repoRoot, memoryConfig.directory);
    ensureMemoryDirs(paths);
    fs.writeFileSync(paths.manifestFile, "{not-json", "utf8");

    let result: ReturnType<typeof retrieveMemoryContext>;
    expect(() => {
      result = retrieveMemoryContext(retrievalInput(repoRoot, memoryConfig));
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it("returns undefined for a first-run repo with no materialized memory state", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith();

    expect(retrieveMemoryContext(retrievalInput(repoRoot, memoryConfig))).toBeUndefined();
  });

  it("lets byReviewer enabled=false win over --with-memory while other reviewers still retrieve", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith({
      retrieval: {
        enabled: false,
        byReviewer: {
          "omre-reviewer-security": { enabled: false },
        },
      },
    });
    writeMemoryState(repoRoot, memoryConfig, [
      validFinding({ id: "mem_1111111111111111", reviewer: "security" }),
      validFinding({ id: "mem_2222222222222222", reviewer: "quality", title: "Quality tenant isolation" }),
    ]);

    const securityResult = retrieveMemoryContext(retrievalInput(repoRoot, memoryConfig, {
      reviewer: "omre-reviewer-security",
      withMemory: true,
    }));
    const qualityResult = retrieveMemoryContext(retrievalInput(repoRoot, memoryConfig, {
      reviewer: "omre-reviewer-quality",
      withMemory: true,
    }));

    expect(securityResult).toBeUndefined();
    expect(qualityResult?.includedIds).toEqual(["mem_2222222222222222"]);
    expect(qualityResult?.text).toContain("Quality tenant isolation");
  });

  it("applies byReviewer includeReviewers and topK before building the context pack", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith({
      retrieval: {
        byReviewer: {
          "omre-reviewer-security": {
            includeReviewers: ["quality"],
            topK: 1,
          },
        },
      },
    });
    writeMemoryState(repoRoot, memoryConfig, [
      validFinding({ id: "mem_1111111111111111", reviewer: "security" }),
      validFinding({ id: "mem_2222222222222222", reviewer: "quality", title: "Quality tenant isolation" }),
      validFinding({ id: "mem_3333333333333333", reviewer: "quality", title: "Second quality tenant isolation" }),
    ]);

    const result = retrieveMemoryContext(retrievalInput(repoRoot, memoryConfig));

    expect(result?.includedIds).toEqual(["mem_2222222222222222"]);
    expect(result?.totalMatched).toBe(1);
    expect(result?.text).not.toContain("mem_1111111111111111");
    expect(result?.text).not.toContain("mem_3333333333333333");
  });

  it("does not full-scan materialized findings when buildSearchQuery returns undefined", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith();
    writeMemoryState(repoRoot, memoryConfig, [validFinding()]);

    const result = retrieveMemoryContext(retrievalInput(repoRoot, memoryConfig, {
      diffSummary: "租户隔离",
      userGuidance: "只检查认证",
      slicePaths: ["src/auth.ts"],
    }));

    expect(result).toBeUndefined();
  });
});

describe("checkAutoCompactThreshold", () => {
  it("warns and keeps needsCompaction=false when segment stats cannot be read", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith();
    writeSegment(repoRoot, memoryConfig, "unreadable.jsonl");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("EACCES");
    });

    const result = checkAutoCompactThreshold(repoRoot, memoryConfig);

    expect(result).toEqual({ needsCompaction: false });
    expect(warnSpy).toHaveBeenCalledWith("memory: failed to read segment stats: EACCES");
  });

  it("returns needsCompaction=false when segment count and age are under thresholds", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith({
      compaction: {
        maxSegmentsBeforeCompaction: 5,
        maxSegmentAgeHours: 24,
      },
    });
    writeSegment(repoRoot, memoryConfig, "recent.jsonl");

    expect(checkAutoCompactThreshold(repoRoot, memoryConfig)).toEqual({ needsCompaction: false });
  });

  it("returns needsCompaction=true with a reason when segment count exceeds the threshold", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith({
      compaction: {
        maxSegmentsBeforeCompaction: 2,
        maxSegmentAgeHours: 24,
      },
    });
    const segmentPath = writeSegment(repoRoot, memoryConfig, "one.jsonl");
    writeSegment(repoRoot, memoryConfig, "two.jsonl");
    writeSegment(repoRoot, memoryConfig, "three.jsonl");

    const result = checkAutoCompactThreshold(repoRoot, memoryConfig);

    expect(result.needsCompaction).toBe(true);
    expect(result.reason).toBe("segments=3 > maxSegmentsBeforeCompaction=2");
    expect(fs.existsSync(segmentPath)).toBe(true);
  });

  it("returns needsCompaction=true with a reason when the oldest segment exceeds max age", () => {
    const repoRoot = makeTempRepo();
    const memoryConfig = memoryConfigWith({
      compaction: {
        maxSegmentsBeforeCompaction: 5,
        maxSegmentAgeHours: 1,
      },
    });
    writeSegment(repoRoot, memoryConfig, "old.jsonl", 3);

    const result = checkAutoCompactThreshold(repoRoot, memoryConfig);

    expect(result.needsCompaction).toBe(true);
    expect(result.reason).toContain("oldestSegmentAgeHours=");
    expect(result.reason).toContain(" > maxSegmentAgeHours=1");
  });
});

describe("autoIndexAfterReview", () => {
  it("delegates to runIndexLatest with the review cwd", () => {
    const repoRoot = makeTempRepo();

    const result = autoIndexAfterReview(repoRoot);

    expect(runIndexLatestMock).toHaveBeenCalledWith({ cwd: repoRoot });
    expect(result.runId).toBe("mock-run");
  });
});

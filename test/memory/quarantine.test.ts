import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { QuarantineEntrySchema, type MemoryManifest } from "../../src/memory/schema.js";
import { appendQuarantineEntry, quarantineFile } from "../../src/memory/quarantine.js";
import { sha256File } from "../../src/memory/ids.js";
import { makeTempRepo } from "./_helpers.js";

describe("quarantineFile", () => {
  it("moves a corrupt file and returns a valid QuarantineEntry", () => {
    const paths = makeTempRepo();
    const corruptName = `${Date.now()}-corrupt.jsonl`;
    const corruptPath = path.join(paths.segmentsDir, corruptName);
    fs.writeFileSync(corruptPath, "{not-json", { encoding: "utf8", flag: "wx" });
    const expectedHash = sha256File(corruptPath).slice(0, 8);

    const entry = quarantineFile(paths, corruptPath, "parse-error", "failed to parse line");

    // Schema validity
    expect(() => QuarantineEntrySchema.parse(entry)).not.toThrow();
    expect(entry.reason).toBe("parse-error");

    // Source removed, destination present
    expect(fs.existsSync(corruptPath)).toBe(false);
    const destAbs = path.join(paths.root, entry.path);
    expect(fs.existsSync(destAbs)).toBe(true);
    expect(fs.readFileSync(destAbs, "utf8")).toBe("{not-json");

    // Destination lives under quarantineDir
    expect(path.dirname(destAbs)).toBe(paths.quarantineDir);
    const stem = corruptName.slice(0, corruptName.length - ".jsonl".length);
    expect(path.basename(destAbs)).toBe(`${stem}-${expectedHash}.jsonl`);

    // Sidecar present and well-formed
    const metaAbs = path.join(paths.root, entry.metaPath);
    expect(fs.existsSync(metaAbs)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaAbs, "utf8")) as Record<string, unknown>;
    expect(meta.schemaVersion).toBe(1);
    expect(meta.reason).toBe("parse-error");
    expect(meta.message).toBe("failed to parse line");
    expect(meta.originalPath).toBe(path.relative(paths.root, corruptPath));
    expect(meta.quarantinedPath).toBe(entry.path);
    expect(typeof meta.movedAt).toBe("string");
    expect(meta.movedAt).toBe(entry.movedAt);
    // sha256 is the full hex of the quarantined content
    expect(meta.sha256).toBe(sha256File(destAbs));
  });

  it("always appends a source hash suffix to the quarantined filename", () => {
    const paths = makeTempRepo();
    const basename = "segment.jsonl";
    const sourcePath = path.join(paths.segmentsDir, basename);
    fs.writeFileSync(sourcePath, "{not-json", { encoding: "utf8", flag: "wx" });

    const expectedHash = sha256File(sourcePath).slice(0, 8);
    const entry = quarantineFile(paths, sourcePath, "parse-error");

    expect(path.basename(entry.path)).toBe(`segment-${expectedHash}.jsonl`);
    expect(() => QuarantineEntrySchema.parse(entry)).not.toThrow();
  });

  it("produces unique filenames for different source files", () => {
    const paths = makeTempRepo();
    const source1 = path.join(paths.segmentsDir, "segment1.jsonl");
    const source2 = path.join(paths.segmentsDir, "segment2.jsonl");
    fs.writeFileSync(source1, "content-a", { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(source2, "content-b", { encoding: "utf8", flag: "wx" });

    const entry1 = quarantineFile(paths, source1, "parse-error");
    const entry2 = quarantineFile(paths, source2, "parse-error");

    expect(entry1.path).not.toBe(entry2.path);
  });

  it("uses the same filename for the same source file (idempotent quarantine)", () => {
    const paths = makeTempRepo();
    const sourcePath = path.join(paths.segmentsDir, "segment.jsonl");
    fs.writeFileSync(sourcePath, "{not-json", { encoding: "utf8", flag: "wx" });

    const entry1 = quarantineFile(paths, sourcePath, "parse-error");

    fs.writeFileSync(sourcePath, "{not-json", { encoding: "utf8" });
    const entry2 = quarantineFile(paths, sourcePath, "parse-error");

    expect(entry1.path).toBe(entry2.path);
    expect(fs.readFileSync(path.join(paths.root, entry2.path), "utf8")).toBe("{not-json");
  });

  it("omits an absent message from the sidecar", () => {
    const paths = makeTempRepo();
    const sourcePath = path.join(paths.segmentsDir, "empty.jsonl");
    fs.writeFileSync(sourcePath, "", { encoding: "utf8", flag: "wx" });

    const entry = quarantineFile(paths, sourcePath, "empty-file");
    const metaAbs = path.join(paths.root, entry.metaPath);
    const meta = JSON.parse(fs.readFileSync(metaAbs, "utf8")) as Record<string, unknown>;
    expect("message" in meta).toBe(false);
    expect(meta.reason).toBe("empty-file");
  });
});

describe("appendQuarantineEntry", () => {
  function baseManifest(overrides: Partial<MemoryManifest> = {}): MemoryManifest {
    return {
      schemaVersion: 1,
      eventSchemaVersion: 1,
      viewSchemaVersion: 1,
      lastRebuiltAt: "2026-05-28T00:00:00.000Z",
      materializedHash: "mat1234567890abcdef",
      relatedIndexHash: "rel1234567890abcdef",
      includedEventFiles: [],
      compactedInputSegments: [],
      gcSummary: {
        lastGcAt: undefined,
        deletedRawSegments: 0,
        deletedTmpFiles: 0,
        deletedQuarantineFiles: 0,
      },
      quarantine: [],
      ...overrides,
    };
  }

  const entry = {
    path: "events/quarantine/segment.jsonl",
    metaPath: "events/quarantine/segment.jsonl.meta.json",
    reason: "parse-error",
    movedAt: "2026-05-28T01:00:00.000Z",
  } as const;

  it("appends to an empty QuarantineEntry[] array without mutating input", () => {
    const manifest = baseManifest();
    const next = appendQuarantineEntry(manifest, entry);

    expect(next.quarantine).toEqual([entry]);
    // Input is not mutated
    expect(manifest.quarantine).toEqual([]);
    expect(next).not.toBe(manifest);
  });

  it("appends to an existing QuarantineEntry[] array", () => {
    const existing = {
      path: "events/quarantine/old.jsonl",
      metaPath: "events/quarantine/old.jsonl.meta.json",
      reason: "schema-error",
      movedAt: "2026-05-27T00:00:00.000Z",
    } as const;
    const manifest = baseManifest({ quarantine: [existing] });
    const next = appendQuarantineEntry(manifest, entry);

    expect(next.quarantine).toEqual([existing, entry]);
  });

  it("migrates a legacy string[] array by replacing it with [entry]", () => {
    const manifest = baseManifest({ quarantine: ["events/quarantine/legacy.jsonl"] });
    const next = appendQuarantineEntry(manifest, entry);

    // Migrate-on-write per C4: legacy string[] is replaced with object array.
    expect(next.quarantine).toEqual([entry]);
  });
});

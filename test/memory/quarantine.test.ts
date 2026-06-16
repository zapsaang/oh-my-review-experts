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
    expect(path.basename(destAbs)).toBe(corruptName);

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

  it("appends a hash suffix when the destination basename collides", () => {
    const paths = makeTempRepo();

    // Pre-existing file in quarantineDir with the target basename.
    const basename = "segment.jsonl";
    const preexisting = path.join(paths.quarantineDir, basename);
    fs.writeFileSync(preexisting, "old quarantined content", { encoding: "utf8", flag: "wx" });

    // Source file with the same basename in segmentsDir.
    const sourcePath = path.join(paths.segmentsDir, basename);
    fs.writeFileSync(sourcePath, "{still-not-json", { encoding: "utf8", flag: "wx" });

    const expectedHash = sha256File(sourcePath).slice(0, 8);
    const entry = quarantineFile(paths, sourcePath, "checksum-mismatch");

    const destAbs = path.join(paths.root, entry.path);
    expect(path.basename(destAbs)).toBe(`segment-${expectedHash}.jsonl`);

    // Original collision target untouched
    expect(fs.readFileSync(preexisting, "utf8")).toBe("old quarantined content");
    // Moved content present at suffixed path
    expect(fs.readFileSync(destAbs, "utf8")).toBe("{still-not-json");
    // Source removed
    expect(fs.existsSync(sourcePath)).toBe(false);

    expect(() => QuarantineEntrySchema.parse(entry)).not.toThrow();
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

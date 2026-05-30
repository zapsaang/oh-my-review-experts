import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { generateMemoryFindingId, sha256File } from "../../src/memory/ids.js";

describe("generateMemoryFindingId", () => {
  it("returns id matching MEMORY_FINDING_ID_PATTERN", () => {
    const id = generateMemoryFindingId();
    expect(id).toMatch(/^mem_[a-z0-9]{16,64}$/);
  });

  it("produces unique ids across 1000 calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateMemoryFindingId());
    }
    expect(ids.size).toBe(1000);
  });
});

describe("sha256File", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-ids-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns correct sha256 hex digest for a known file", () => {
    const content = "hello world for sha256File test";
    const filePath = path.join(tmpDir, "fixture.txt");
    fs.writeFileSync(filePath, content, "utf8");

    const expected = createHash("sha256").update(content).digest("hex");
    const result = sha256File(filePath);

    expect(result).toBe(expected);
    expect(result).toHaveLength(64);
  });

  it("is stable across two calls on the same file", () => {
    const content = "stable hash test content";
    const filePath = path.join(tmpDir, "stable.txt");
    fs.writeFileSync(filePath, content, "utf8");

    const first = sha256File(filePath);
    const second = sha256File(filePath);

    expect(first).toBe(second);
  });
});

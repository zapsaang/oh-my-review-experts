import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertSafePath, writeFileAtomic, writeFileAtomicOverwrite, formatTimestamp, makeTempPath } from "../../src/tools/fs-utils.js";

describe("assertSafePath", () => {
  it("allows paths within base directory", () => {
    expect(() => assertSafePath("/project/reports", "/project", "test")).not.toThrow();
    expect(() => assertSafePath("/project", "/project", "test")).not.toThrow();
  });

  it("blocks path traversal", () => {
    expect(() => assertSafePath("/project/../etc", "/project", "test")).toThrow("Path traversal blocked");
    expect(() => assertSafePath("/project/../../etc", "/project", "test")).toThrow("Path traversal blocked");
  });

  it("blocks paths outside base", () => {
    expect(() => assertSafePath("/other", "/project", "test")).toThrow("Path traversal blocked");
  });
});

describe("writeFileAtomic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-atomic-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes file and returns path", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const result = writeFileAtomic(filePath, "hello");
    expect(result).toBe(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe("hello");
  });

  it("handles collisions by appending suffix", () => {
    const filePath = path.join(tmpDir, "test.txt");
    writeFileAtomic(filePath, "first");
    const result = writeFileAtomic(filePath, "second");
    expect(result).toBe(path.join(tmpDir, "test-1.txt"));
    expect(fs.readFileSync(filePath, "utf8")).toBe("first");
    expect(fs.readFileSync(result, "utf8")).toBe("second");
  });
});

describe("writeFileAtomicOverwrite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-atomic-ow-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("overwrites existing file", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "old", "utf8");
    writeFileAtomicOverwrite(filePath, "new");
    expect(fs.readFileSync(filePath, "utf8")).toBe("new");
  });
});

describe("formatTimestamp", () => {
  it("returns consistent format", () => {
    const ts = formatTimestamp(new Date(2026, 4, 7, 12, 30, 45, 123));
    expect(ts).toBe("20260507-123045-123");
  });

  it("pads single digits", () => {
    const ts = formatTimestamp(new Date(2026, 0, 1, 1, 2, 3, 7));
    expect(ts).toBe("20260101-010203-007");
  });
});

describe("makeTempPath", () => {
  it("produces 1000 distinct paths in a tight loop", () => {
    const paths = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      paths.add(makeTempPath("/tmp/target.txt"));
    }
    expect(paths.size).toBe(1000);
  });

  it("matches expected format", () => {
    const p = makeTempPath("/tmp/target.txt");
    expect(p).toMatch(/^.*\.tmp\.\d+\.\d+\.[0-9a-f]{12}$/);
  });
});

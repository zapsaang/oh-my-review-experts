import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertSafePath, writeFileAtomic, writeFileAtomicOverwrite, formatTimestamp, makeTempPath } from "../../src/tools/fs-utils.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    vi.restoreAllMocks();
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

  it("writeFileAtomic throws after 10 EEXIST collisions", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });

    expect(() => writeFileAtomic(filePath, "hello")).toThrow(/retr|exhaust|attempt/i);
    expect(writeFileSpy).toHaveBeenCalledTimes(10);
  });

  it("writeFileAtomic propagates ENOSPC errors immediately", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });

    expect(() => writeFileAtomic(filePath, "hello")).toThrow(/disk full/);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
  });

  it("writeFileAtomic propagates EACCES errors immediately", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(() => writeFileAtomic(filePath, "hello")).toThrow(/permission denied/);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
  });

  it("writeFileAtomic propagates EIO errors immediately", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("i/o error"), { code: "EIO" });
    });

    expect(() => writeFileAtomic(filePath, "hello")).toThrow(/i\/o error/);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
  });
});

describe("writeFileAtomicOverwrite", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-atomic-ow-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("overwrites existing file", () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "old", "utf8");
    writeFileAtomicOverwrite(filePath, "new");
    expect(fs.readFileSync(filePath, "utf8")).toBe("new");
  });

  it("uses collision-resistant temp file name", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");

    writeFileAtomicOverwrite(filePath, "new");

    const tempPath = writeFileSpy.mock.calls[0]?.[0];
    if (typeof tempPath !== "string") {
      throw new Error("Expected writeFileSync to receive a temp file path");
    }
    expect(tempPath).toMatch(new RegExp(String.raw`^${escapeRegExp(filePath)}\.tmp\.\d+\.\d+\.[0-9a-f]{12}$`));
  });

  it("survives tight-loop overwrites without temp path collisions", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");
    vi.spyOn(Date, "now").mockReturnValue(1716000000000);

    for (let i = 0; i < 10; i++) {
      writeFileAtomicOverwrite(filePath, `content-${i}`);
    }

    const tempPaths = writeFileSpy.mock.calls.map(([tempPath]) => {
      if (typeof tempPath !== "string") {
        throw new Error("Expected writeFileSync to receive temp file paths");
      }
      return tempPath;
    });
    expect(new Set(tempPaths).size).toBe(10);
    expect(fs.readFileSync(filePath, "utf8")).toBe("content-9");
  });

  it("cleans up temp file when rename fails", () => {
    const filePath = path.join(tmpDir, "test.txt");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });

    expect(() => writeFileAtomicOverwrite(filePath, "new")).toThrow("rename failed");

    const writeCall = writeFileSpy.mock.calls[0];
    if (writeCall === undefined) {
      throw new Error("Expected writeFileSync to be called");
    }
    const [tempPath, , options] = writeCall;
    if (typeof tempPath !== "string") {
      throw new Error("Expected writeFileSync to receive a temp file path");
    }
    expect(options).toEqual({ flag: "wx", encoding: "utf8" });
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
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

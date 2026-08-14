import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface RunMeta {
  withMemory: boolean;
  noMemory: boolean;
}

async function loadRunMeta(): Promise<{
  writeRunMeta(handoffDir: string, meta: RunMeta): string;
  readRunMeta(handoffDir: string): RunMeta | undefined;
}> {
  const segments = ["..", "..", "src", "workflow", "run-meta.js"];
  const modPath = segments.join("/");
  const mod = await import(modPath);
  return mod as unknown as {
    writeRunMeta(handoffDir: string, meta: RunMeta): string;
    readRunMeta(handoffDir: string): RunMeta | undefined;
  };
}

describe("run-meta", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-run-meta-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("write+read round-trip", async () => {
    const { writeRunMeta, readRunMeta } = await loadRunMeta();
    const handoffDir = path.join(tmpDir, "handoff");
    fs.mkdirSync(handoffDir, { recursive: true });

    const written = writeRunMeta(handoffDir, { withMemory: true, noMemory: false });
    expect(written).toBe(path.join(handoffDir, ".run-meta.json"));

    const read = readRunMeta(handoffDir);
    expect(read).toEqual({ withMemory: true, noMemory: false });
  });

  it("missing dir returns undefined", async () => {
    const { readRunMeta } = await loadRunMeta();
    const missingDir = path.join(tmpDir, "missing", "handoff");
    const read = readRunMeta(missingDir);
    expect(read).toBeUndefined();
  });

  it("read failure does not expose the metadata path", async () => {
    const { readRunMeta } = await loadRunMeta();
    const handoffDir = path.join(tmpDir, "handoff");
    fs.mkdirSync(path.join(handoffDir, ".run-meta.json"), { recursive: true });

    expect(() => readRunMeta(handoffDir)).toThrow(/^readRunMeta: failed to read run metadata$/);
  });

  it("corrupt JSON surfaces a clear error", async () => {
    const { readRunMeta } = await loadRunMeta();
    const handoffDir = path.join(tmpDir, "handoff");
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, ".run-meta.json"), "not-json", { encoding: "utf8" });

    expect(() => readRunMeta(handoffDir)).toThrow(/^readRunMeta: invalid JSON in run metadata$/);
  });

  // slop-fix: fails until B6 fix lands
  it("surfaces corrupt JSON instead of treating run metadata as absent", async () => {
    const { readRunMeta } = await loadRunMeta();
    const handoffDir = path.join(tmpDir, "corrupt-handoff");
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, ".run-meta.json"), "not-json", { encoding: "utf8" });

    expect(() => readRunMeta(handoffDir)).toThrow();
  });

  it("non-object JSON returns undefined", async () => {
    const { readRunMeta } = await loadRunMeta();
    const handoffDir = path.join(tmpDir, "handoff");
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, ".run-meta.json"), JSON.stringify("string"), { encoding: "utf8" });

    const read = readRunMeta(handoffDir);
    expect(read).toBeUndefined();
  });

  it("partial object coerces missing fields to false", async () => {
    const { readRunMeta } = await loadRunMeta();
    const handoffDir = path.join(tmpDir, "handoff");
    fs.mkdirSync(handoffDir, { recursive: true });
    fs.writeFileSync(path.join(handoffDir, ".run-meta.json"), JSON.stringify({ withMemory: true }), { encoding: "utf8" });

    const read = readRunMeta(handoffDir);
    expect(read).toEqual({ withMemory: true, noMemory: false });
  });
});

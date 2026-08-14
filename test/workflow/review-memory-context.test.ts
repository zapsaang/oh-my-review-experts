import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { ensureMemoryDirs, resolveMemoryPaths } from "../../src/memory/paths.js";
import { hasMaterializedMemoryState } from "../../src/workflow/review-memory-context.js";

describe("hasMaterializedMemoryState", () => {
  // slop-fix: fails until B4 fix lands
  it("surfaces corrupt materialized state instead of reporting that state was not found", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omre-memory-state-"));
    const paths = resolveMemoryPaths(repoRoot, DEFAULT_CONFIG.memory.directory);
    ensureMemoryDirs(paths);
    fs.writeFileSync(paths.manifestFile, "{ corrupt JSON", "utf8");

    try {
      expect(() => hasMaterializedMemoryState(repoRoot, DEFAULT_CONFIG)).toThrow();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

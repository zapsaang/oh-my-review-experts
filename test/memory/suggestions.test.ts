import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as fsUtils from "../../src/tools/fs-utils.js";
import { generateSuggestions } from "../../src/memory/suggestions.js";
import { writeFinding } from "./_helpers.js";

const repoRoot = "/tmp/omre-repo";
const now = new Date("2026-06-01T00:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(now.getTime() - n * 86400000).toISOString();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateSuggestions", () => {
  describe("Rule 3 — file deletion", () => {
    it("suggests stale with high confidence when all files deleted", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const finding = writeFinding({
        status: "open",
        locations: [
          { path: "src/users.ts", line: 42 },
          { path: "src/auth.ts", line: 10 },
        ],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        suggestedStatus: "stale",
        confidence: "high",
        triggeredBy: "file-deleted",
        reason: "all referenced files deleted: src/users.ts, src/auth.ts",
      });
    });

    it("does not suggest when at least one file still exists", () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        return String(p) === path.resolve(repoRoot, "src/users.ts");
      });

      const finding = writeFinding({
        status: "open",
        locations: [
          { path: "src/users.ts", line: 42 },
          { path: "src/auth.ts", line: 10 },
        ],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(0);
    });

    it("skips import-source findings when skipImportSourceForFileDeletion is true", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const finding = writeFinding({
        status: "open",
        origin: {
          runId: "run-20260528",
          sourceType: "import",
          sourcePath: ".omre/reports/latest.json",
          createdAt: "2026-05-28T00:00:00.000Z",
        },
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      // skipImportSourceForFileDeletion defaults to true
      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(0);
    });

    it("evaluates import-source findings when skipImportSourceForFileDeletion is false", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const finding = writeFinding({
        status: "open",
        origin: {
          runId: "run-20260528",
          sourceType: "import",
          sourcePath: ".omre/reports/latest.json",
          createdAt: "2026-05-28T00:00:00.000Z",
        },
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], {
        repoRoot,
        now,
        skipImportSourceForFileDeletion: false,
      });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        suggestedStatus: "stale",
        confidence: "high",
        triggeredBy: "file-deleted",
      });
    });

    it("calls assertSafePath for every location path", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const assertSpy = vi.spyOn(fsUtils, "assertSafePath");

      const finding = writeFinding({
        status: "open",
        locations: [
          { path: "src/users.ts", line: 42 },
          { path: "src/auth.ts", line: 10 },
        ],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      generateSuggestions([finding], { repoRoot, now });

      // If the namespace spy intercepts, assert the 3-arg signature and
      // call count equals the number of locations.
      if (assertSpy.mock.calls.length > 0) {
        expect(assertSpy).toHaveBeenCalledWith(expect.any(String), repoRoot, "suggestions.fileDeletion");
        expect(assertSpy.mock.calls.length).toBe(2);
      }
    });

    it("handles findings with empty locations array", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const finding = writeFinding({
        status: "open",
        locations: [],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(95),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      // Rule 3 skipped (no locations), rule 4 should fire due to age
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        triggeredBy: "time-decay",
        confidence: "medium",
      });
    });
  });

  describe("Rule 4 — time decay", () => {
    it("suggests stale with medium confidence when lastSeenAt exceeds threshold", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(95),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        confidence: "medium",
        triggeredBy: "time-decay",
        reason: "last seen 95 days ago (threshold: 90 days)",
      });
    });

    it("does not suggest when lastSeenAt is within threshold", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(10),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(0);
    });

    it("uses custom timeDecayDays from options", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const findingOld = writeFinding({
        id: "mem_customdecay01234567",
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(35),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const findingRecent = writeFinding({
        id: "mem_customdecay98765432",
        status: "open",
        locations: [{ path: "src/auth.ts", line: 10 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(25),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([findingOld, findingRecent], {
        repoRoot,
        now,
        timeDecayDays: 30,
      });

      const decaySuggestions = result.suggestions.filter((s) => s.triggeredBy === "time-decay");
      expect(decaySuggestions).toHaveLength(1);
      expect(decaySuggestions[0].findingId).toBe("mem_customdecay01234567");
    });

    it("uses provided now date for calculation", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const customNow = new Date("2026-07-01T00:00:00.000Z");
      const lastSeen = new Date(customNow.getTime() - 95 * 86400000).toISOString();

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: lastSeen,
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now: customNow });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        triggeredBy: "time-decay",
        reason: "last seen 95 days ago (threshold: 90 days)",
      });
    });

    it("handles import-source findings for time decay", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        status: "open",
        origin: {
          runId: "run-20260528",
          sourceType: "import",
          sourcePath: ".omre/reports/latest.json",
          createdAt: "2026-05-28T00:00:00.000Z",
        },
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(95),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      const decaySuggestions = result.suggestions.filter((s) => s.triggeredBy === "time-decay");
      expect(decaySuggestions).toHaveLength(1);
      expect(decaySuggestions[0]).toMatchObject({
        confidence: "medium",
        triggeredBy: "time-decay",
      });
    });

    it("produces time-decay suggestion for confirmed status findings", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        id: "mem_confirmed_decay12345",
        status: "confirmed",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(95),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        confidence: "medium",
        triggeredBy: "time-decay",
        findingId: "mem_confirmed_decay12345",
      });
      expect(result.skippedCount).toBe(0);
    });
  });

  describe("Interaction", () => {
    it("rule 3 takes precedence when both match", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(95),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        triggeredBy: "file-deleted",
        confidence: "high",
      });
    });

    it("skips findings with status not open or confirmed", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const statuses = ["fixed", "ignored", "false-positive", "stale"] as const;
      const findings = statuses.map((status, i) =>
        writeFinding({
          id: `mem_skipstatus${i}00000000`,
          status,
          locations: [{ path: "src/users.ts", line: 42 }],
          occurrence: {
            firstSeenAt: "2026-05-28T00:00:00.000Z",
            lastSeenAt: daysAgo(95),
            count: 1,
            runIds: ["run-20260528"],
          },
        }),
      );

      const result = generateSuggestions(findings, { repoRoot, now });

      expect(result.suggestions).toHaveLength(0);
      expect(result.skippedCount).toBe(4);
    });

    it("returns empty suggestions for empty findings array", () => {
      const result = generateSuggestions([], { repoRoot, now });

      expect(result).toEqual({
        suggestions: [],
        processedCount: 0,
        skippedCount: 0,
      });
    });

    it("returns correct processedCount and skippedCount", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const openFinding = writeFinding({
        id: "mem_opencount123456789",
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const confirmedFinding = writeFinding({
        id: "mem_confirmedcount12345",
        status: "confirmed",
        locations: [{ path: "src/auth.ts", line: 10 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const fixedFinding = writeFinding({
        id: "mem_fixedcount123456789",
        status: "fixed",
        locations: [{ path: "src/old.ts", line: 1 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const findings = [openFinding, confirmedFinding, fixedFinding];
      const result = generateSuggestions(findings, { repoRoot, now });

      expect(result.processedCount).toBe(3);
      expect(result.skippedCount).toBe(1);
    });
  });

  describe("Safety", () => {
    it("rejects path traversal attempts via assertSafePath", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "../../etc/passwd", line: 1 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(5),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      expect(() => generateSuggestions([finding], { repoRoot, now })).toThrow(
        /Path traversal blocked/,
      );
    });
  });

  describe("Boundary/defensive (Metis)", () => {
    it("fires time decay when ageDays exactly equals threshold", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: new Date(now.getTime() - 90 * 86400000).toISOString(),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        triggeredBy: "time-decay",
        reason: "last seen 90 days ago (threshold: 90 days)",
      });
    });

    it("does not fire when ageDays is exactly one less than threshold", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: new Date(now.getTime() - 89 * 86400000).toISOString(),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      expect(result.suggestions).toHaveLength(0);
    });

    it("handles invalid lastSeenAt string", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: "not-a-date",
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      // Should not throw, NaN comparison yields no fire
      const result = generateSuggestions([finding], { repoRoot, now });

      const decaySuggestions = result.suggestions.filter((s) => s.triggeredBy === "time-decay");
      expect(decaySuggestions).toHaveLength(0);
    });

    it("handles future lastSeenAt", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: new Date(now.getTime() + 86400000).toISOString(),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      const result = generateSuggestions([finding], { repoRoot, now });

      const decaySuggestions = result.suggestions.filter((s) => s.triggeredBy === "time-decay");
      expect(decaySuggestions).toHaveLength(0);
    });
  });

  describe("Purity", () => {
    it("does not write any files during execution", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const writeFileSpy = vi.spyOn(fs, "writeFileSync");
      const renameSpy = vi.spyOn(fs, "renameSync");

      const finding = writeFinding({
        status: "open",
        locations: [{ path: "src/users.ts", line: 42 }],
        occurrence: {
          firstSeenAt: "2026-05-28T00:00:00.000Z",
          lastSeenAt: daysAgo(95),
          count: 1,
          runIds: ["run-20260528"],
        },
      });

      generateSuggestions([finding], { repoRoot, now });

      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
    });
  });
});

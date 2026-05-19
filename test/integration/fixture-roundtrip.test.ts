import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  UnifiedHandoffSchema,
  SlicePlannerSchema,
  SlicePlanValidatorSchema,
  ResultValidatorSchema,
  SliceArbiterSchema,
  GlobalArbiterSchema,
} from "../../src/agents/schemas.js";
import { validateReviewerHandoff, validateHandoffFromChat } from "../../src/workflow/validate-result.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.resolve(__dirname, "../fixtures/handoffs");

function loadFixture(relPath: string): { raw: string; parsed: unknown } {
  const filePath = path.join(fixtureDir, relPath);
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return { raw, parsed };
}

function loadFixtureMarkdown(relPath: string): string {
  const filePath = path.join(fixtureDir, relPath);
  return fs.readFileSync(filePath, "utf-8");
}

function withTempCwd<T>(fn: (cwd: string) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omre-fixture-"));
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("fixture roundtrip", () => {
  it("SCHEMA_VERSION constant is '1' (bump must regenerate fixtures)", () => {
    expect(SCHEMA_VERSION).toBe("1");
  });

  describe("Reviewer canonical and variants (UnifiedHandoffSchema)", () => {
    const cases = [
      { rel: "reviewer/canonical.json", expectFindings: 1 },
      { rel: "reviewer/multi-finding.json", expectFindings: 3 },
      { rel: "reviewer/empty-findings.json", expectFindings: 0 },
    ];

    it.each(cases)("$rel passes UnifiedHandoffSchema.safeParse with $expectFindings findings", ({ rel, expectFindings }) => {
      const { parsed } = loadFixture(rel);
      const r = UnifiedHandoffSchema.safeParse(parsed);

      expect(r.success).toBe(true);

      if (r.success) {
        expect(r.data.schema_version).toBe(SCHEMA_VERSION);
        expect(r.data.findings.length).toBe(expectFindings);
      }
    });
  });

  describe("Coordinator canonical fixtures", () => {
    const cases = [
      { rel: "coordinator/slice-planner.canonical.json", schema: SlicePlannerSchema, name: "SlicePlannerSchema" },
      {
        rel: "coordinator/slice-plan-validator.canonical.json",
        schema: SlicePlanValidatorSchema,
        name: "SlicePlanValidatorSchema",
      },
      { rel: "coordinator/result-validator.canonical.json", schema: ResultValidatorSchema, name: "ResultValidatorSchema" },
      { rel: "coordinator/slice-arbiter.canonical.json", schema: SliceArbiterSchema, name: "SliceArbiterSchema" },
      { rel: "coordinator/global-arbiter.canonical.json", schema: GlobalArbiterSchema, name: "GlobalArbiterSchema" },
    ];

    it.each(cases)("$rel passes $name", ({ rel, schema }) => {
      const { parsed } = loadFixture(rel);
      const r = schema.safeParse(parsed);

      expect(r.success).toBe(true);

      if (!r.success) {
        expect(r.error.issues).toEqual([]);
      }

      const data = parsed as { schema_version?: string };
      expect(data.schema_version).toBe(SCHEMA_VERSION);
    });
  });

  describe("Invalid fixtures fail with exact failureReason", () => {
    type FailureReason =
      | "missing-output"
      | "invalid-json"
      | "partial-output"
      | "wrong-dimension"
      | "wrong-target"
      | "wrong-slice"
      | "invalid-schema"
      | "prose-outside-json"
      | "missing-fence";

    type Case = {
      rel: string;
      mode: "chat" | "fileWithExpected";
      expected?: { dimension?: string; target?: { kind: string; value: string }; sliceId?: string };
      failureReason: FailureReason;
    };

    const cases: Case[] = [
      { rel: "invalid/wrong-major-version.json", mode: "chat", failureReason: "invalid-schema" },
      { rel: "invalid/missing-fence.md", mode: "chat", failureReason: "missing-fence" },
      { rel: "invalid/partial-output.json", mode: "chat", failureReason: "partial-output" },
      { rel: "invalid/prose-outside-json.md", mode: "fileWithExpected", failureReason: "prose-outside-json" },
      {
        rel: "invalid/wrong-dimension.json",
        mode: "fileWithExpected",
        expected: { dimension: "security" },
        failureReason: "wrong-dimension",
      },
      {
        rel: "invalid/wrong-target.json",
        mode: "fileWithExpected",
        expected: { target: { kind: "working-tree", value: "src/example.ts" } },
        failureReason: "wrong-target",
      },
      {
        rel: "invalid/wrong-slice.json",
        mode: "fileWithExpected",
        expected: { sliceId: "slice-001" },
        failureReason: "wrong-slice",
      },
    ];

    it.each(cases)("$rel -> failureReason = $failureReason", ({ rel, mode, expected, failureReason }) => {
      const content = path.extname(rel) === ".md" ? loadFixtureMarkdown(rel) : `\`\`\`json\n${loadFixture(rel).raw}\n\`\`\`\n`;

      if (mode === "chat") {
        const r = validateHandoffFromChat(content);

        expect(r.isValid).toBe(false);

        if (!r.isValid) {
          expect(r.failureReason).toBe(failureReason);
        }

        return;
      }

      withTempCwd((cwd) => {
        const filePath = path.join(cwd, "handoff.md");
        fs.writeFileSync(filePath, content, "utf8");

        const r = validateReviewerHandoff(filePath, expected);

        expect(r.isValid).toBe(false);

        if (!r.isValid) {
          expect(r.failureReason).toBe(failureReason);
        }
      });
    });
  });
});

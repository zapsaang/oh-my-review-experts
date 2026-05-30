import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractFromHandoffs } from "../../../src/memory/extractor/handoff-extractor.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(testDir, "../fixtures/handoff-sample.md");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `omre-handoff-extractor-${process.pid}-${tempDirs.length}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeHandoff(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf8");
}

describe("extractFromHandoffs", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts structured findings from the JSON header and uses header agent as reviewer", () => {
    const dir = makeTempDir();
    copyFileSync(fixturePath, join(dir, "filename-must-not-be-reviewer.md"));
    writeHandoff(dir, "ignored.json", "{}");

    const findings = extractFromHandoffs(dir);

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      reviewer: "omre-reviewer-security",
      severity: "high",
      category: "secret-leak",
      title: "Hardcoded JWT secret in source",
      problem: "Any developer with repo access can extract the secret and forge tokens.",
      evidence: "const SECRET = 'super-secret-key-123';",
      recommendation: "Move the secret to an environment variable and inject it at runtime.",
      locations: [{ path: "src/auth.ts", line: 42 }],
    });
  });

  it("parses numeric markdown line values as numbers", () => {
    const dir = makeTempDir();
    copyFileSync(fixturePath, join(dir, "security.md"));

    const [finding] = extractFromHandoffs(dir);

    expect(finding?.locations).toEqual([{ path: "src/auth.ts", line: 42 }]);
  });

  it("keeps non-numeric markdown line values as strings", () => {
    const dir = makeTempDir();
    copyFileSync(fixturePath, join(dir, "security.md"));

    const findings = extractFromHandoffs(dir);

    expect(findings[1]?.locations).toEqual([{ path: "src/middleware.ts", line: "87-92" }]);
  });

  it("returns an empty array when a handoff has no JSON header and no Findings section", () => {
    const dir = makeTempDir();
    writeHandoff(dir, "empty.md", "# Not a handoff\n\nNo structured content here.\n");

    expect(extractFromHandoffs(dir)).toEqual([]);
  });

  it("merges findings from multiple markdown handoff files", () => {
    const dir = makeTempDir();
    copyFileSync(fixturePath, join(dir, "a.md"));
    copyFileSync(fixturePath, join(dir, "b.md"));

    const findings = extractFromHandoffs(dir);

    expect(findings).toHaveLength(4);
    expect(findings.map((finding) => finding.reviewer)).toEqual([
      "omre-reviewer-security",
      "omre-reviewer-security",
      "omre-reviewer-security",
      "omre-reviewer-security",
    ]);
  });

  it("falls back to markdown Finding sections when the JSON header has no structured findings", () => {
    const dir = makeTempDir();
    writeHandoff(
      dir,
      "markdown-only-findings.md",
      `\`\`\`json
{
  "agent": "omre-reviewer-quality",
  "scope": "queue-module",
  "slice_id": "queue-module",
  "findings": []
}
\`\`\`

# Review Handoff

## Findings

### Finding 1

- Severity: low
- Category: maintainability
- File: src/queue.ts
- Lines: N/A
- Evidence: Queue setup is repeated in two call sites.
- Impact: Repeated setup makes future queue options easy to update in only one place.
- Recommendation: Extract a shared queue factory.
`,
    );

    expect(extractFromHandoffs(dir)).toEqual([
      {
        reviewer: "omre-reviewer-quality",
        severity: "low",
        category: "maintainability",
        title: "Finding 1",
        problem: "Repeated setup makes future queue options easy to update in only one place.",
        evidence: "Queue setup is repeated in two call sites.",
        recommendation: "Extract a shared queue factory.",
        locations: [{ path: "src/queue.ts", line: "N/A" }],
      },
    ]);
  });
});

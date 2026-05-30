import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawFinding } from "../../src/memory/extractor/types.js";

vi.mock("../../src/tools/secret-scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/secret-scanner.js")>();

  return {
    ...actual,
    redactSecrets: vi.fn((text: string) => actual.redactSecrets(text)),
  };
});

import { redactPath, redactRawFinding, redactText } from "../../src/memory/redaction.js";
import { redactSecrets } from "../../src/tools/secret-scanner.js";

const mockedRedactSecrets = vi.mocked(redactSecrets);

function expectRedacted(original: string): string {
  const redacted = redactText(original);

  expect(redacted).not.toBe(original);
  expect(redacted).toContain("[REDACTED");
  return redacted;
}

describe("redactText", () => {
  beforeEach(() => {
    mockedRedactSecrets.mockClear();
  });

  it("delegates built-in secret redaction before returning text", () => {
    const redacted = expectRedacted("leaked token ghp_0123456789abcdefghijklmnopqrstuvwxyz");

    expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(mockedRedactSecrets).toHaveBeenCalledTimes(1);
    expect(mockedRedactSecrets).toHaveBeenCalledWith("leaked token ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts password-bearing connection string text through the secret scanner", () => {
    const redacted = expectRedacted("DATABASE_URL=postgres://db.example/app?password=hunter22ABC");

    expect(redacted).toContain("[REDACTED_PASSWORD]");
  });

  it("applies extra patterns after built-in redaction without replacing built-in markers", () => {
    const redacted = redactText("incident OMRE-1234 api_key=abcdefghijklmnop", {
      extraPatterns: [{ pattern: /OMRE-\d+/g, replacement: "[REDACTED_TICKET]" }],
    });

    expect(redacted).toBe("incident [REDACTED_TICKET] [REDACTED_API_KEY]");
  });
});

describe("redactPath", () => {
  it("strips embedded hash and version suffixes while preserving directory structure", () => {
    expect(redactPath("src/repos/OrderRepo-a1b2c3d4.ts")).toBe("src/repos/OrderRepo.ts");
    expect(redactPath("src/generated/client-v1.2.3.ts")).toBe("src/generated/client.ts");
  });
});

describe("redactRawFinding", () => {
  it("redacts finding text fields and location paths", () => {
    const finding: RawFinding = {
      reviewer: "security",
      severity: "high",
      category: "secret",
      title: "AWS key AKIAIOSFODNN7EXAMPLE exposed",
      problem: "Commit includes token ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      evidence: "Authorization header bearer abcdefghijklmnopqrstuv",
      recommendation: "Rotate password=hunter22ABC immediately",
      locations: [
        { path: "src/repos/OrderRepo-a1b2c3d4.ts", line: 12 },
        { path: "src/generated/client-v1.2.3.ts" },
      ],
    };

    expect(redactRawFinding(finding)).toEqual({
      reviewer: "security",
      severity: "high",
      category: "secret",
      title: "AWS key [REDACTED_AWS_ACCESS_KEY_ID] exposed",
      problem: "Commit includes token [REDACTED_GITHUB_TOKEN]",
      evidence: "Authorization header [REDACTED_BEARER_TOKEN]",
      recommendation: "Rotate [REDACTED_PASSWORD] immediately",
      locations: [
        { path: "src/repos/OrderRepo.ts", line: 12 },
        { path: "src/generated/client.ts" },
      ],
    });
  });
});

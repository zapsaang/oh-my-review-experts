import { describe, it, expect } from "vitest";
import { parseReviewScope } from "../../src/workflow/scope-resolver.js";

describe("parseReviewScope", () => {
  it('returns default scope for empty string', () => {
    expect(parseReviewScope("", "/tmp")).toEqual({ kind: "default" });
  });

  it('returns guidance scope for non-empty text', () => {
    expect(parseReviewScope("focus on security", "/tmp")).toEqual({
      kind: "guidance",
      text: "focus on security",
    });
  });
});

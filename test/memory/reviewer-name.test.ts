import { describe, expect, it } from "vitest";
import { REVIEWER_PREFIX, canonicalReviewerName } from "../../src/memory/reviewer-name.js";

describe("canonicalReviewerName", () => {
  it("keeps bare reviewer dimensions unchanged", () => {
    expect(canonicalReviewerName("security")).toBe("security");
  });

  it("strips the OMRE reviewer prefix", () => {
    expect(canonicalReviewerName(`${REVIEWER_PREFIX}security`)).toBe("security");
  });

  it("keeps an empty reviewer unchanged", () => {
    expect(canonicalReviewerName("")).toBe("");
  });

  it("does not strip unknown reviewer-like prefixes", () => {
    expect(canonicalReviewerName("my-reviewer-security")).toBe("my-reviewer-security");
  });

  it("returns an empty reviewer for the prefix alone", () => {
    expect(canonicalReviewerName(REVIEWER_PREFIX)).toBe("");
  });
});

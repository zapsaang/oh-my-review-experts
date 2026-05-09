import { describe, it, expect } from "vitest";
import { GitError } from "../../src/tools/git.js";

describe("GitError", () => {
  it("has correct name and message", () => {
    const err = new GitError("Something failed", ["diff", "--stat"]);
    expect(err.name).toBe("GitError");
    expect(err.message).toBe("Something failed");
    expect(err.command).toEqual(["diff", "--stat"]);
  });

  it("preserves cause when provided", () => {
    const cause = new Error("Underlying error");
    const err = new GitError("Wrapper", ["log"], cause);
    expect(err.cause).toBe(cause);
  });
});

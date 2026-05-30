import { describe, expect, it } from "vitest";
import { MemoryExtractionError } from "../../../src/memory/extractor/types.js";

describe("MemoryExtractionError", () => {
  it("has the correct name, preserves sourcePath, and is an instance of Error", () => {
    const err = new MemoryExtractionError("extraction failed", "/path/to/report.json");

    expect(err.name).toBe("MemoryExtractionError");
    expect(err.message).toBe("extraction failed");
    expect(err.sourcePath).toBe("/path/to/report.json");
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts an optional cause", () => {
    const cause = new Error("underlying parse error");
    const err = new MemoryExtractionError("extraction failed", "/path/to/report.json", cause);

    expect(err.cause).toBe(cause);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_STOP_WORDS, jaccardSimilarity, tokenizeForSimilarity } from "../../src/memory/similarity.js";

describe("DEFAULT_STOP_WORDS", () => {
  it("contains common English stop words", () => {
    expect(DEFAULT_STOP_WORDS.has("the")).toBe(true);
    expect(DEFAULT_STOP_WORDS.has("and")).toBe(true);
    expect(DEFAULT_STOP_WORDS.has("is")).toBe(true);
    expect(DEFAULT_STOP_WORDS.has("for")).toBe(true);
    expect(DEFAULT_STOP_WORDS.has("to")).toBe(true);
    expect(DEFAULT_STOP_WORDS.has("a")).toBe(true);
  });

  it("does not contain technical-looking tokens", () => {
    expect(DEFAULT_STOP_WORDS.has("tenant_id")).toBe(false);
    expect(DEFAULT_STOP_WORDS.has("API_KEY")).toBe(false);
    expect(DEFAULT_STOP_WORDS.has("v2")).toBe(false);
  });
});

describe("tokenizeForSimilarity", () => {
  it("lowercases tokens", () => {
    expect(tokenizeForSimilarity("Hello World")).toEqual(["hello", "world"]);
  });

  it("splits on non-alphanumeric characters", () => {
    expect(tokenizeForSimilarity("hello, world! foo.bar")).toEqual(["hello", "world", "foo", "bar"]);
  });

  it("filters out tokens shorter than 2 characters", () => {
    expect(tokenizeForSimilarity("a b cd e fgh")).toEqual(["cd", "fgh"]);
  });

  it("drops stop words", () => {
    expect(tokenizeForSimilarity("the quick brown fox")).toEqual(["quick", "brown", "fox"]);
    expect(tokenizeForSimilarity("this is a test for the function")).toEqual(["test", "function"]);
  });

  it("preserves technical tokens with underscores", () => {
    expect(tokenizeForSimilarity("tenant_id and user_name")).toContain("tenant_id");
    expect(tokenizeForSimilarity("tenant_id and user_name")).toContain("user_name");
  });

  it("preserves technical tokens with hyphens", () => {
    expect(tokenizeForSimilarity("x-api-key header")).toContain("x-api-key");
  });

  it("preserves technical tokens with digits", () => {
    expect(tokenizeForSimilarity("version v2 release")).toContain("v2");
  });

  it("preserves technical tokens with uppercase letters", () => {
    expect(tokenizeForSimilarity("use API_KEY here")).toContain("API_KEY");
  });

  it("preserves camelCase tokens", () => {
    expect(tokenizeForSimilarity("tenantId field")).toContain("tenantId");
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeForSimilarity("")).toEqual([]);
  });

  it("returns empty array for string with only stop words", () => {
    expect(tokenizeForSimilarity("the and is")).toEqual([]);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1.0);
  });

  it("returns 0 for disjoint strings", () => {
    expect(jaccardSimilarity("hello world", "foo bar")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
  });

  it("returns 0 when one string is empty", () => {
    expect(jaccardSimilarity("hello world", "")).toBe(0);
    expect(jaccardSimilarity("", "hello world")).toBe(0);
  });

  it("returns correct value for partial overlap", () => {
    // "hello world" -> ["hello", "world"]
    // "hello there" -> ["hello", "there"]
    // intersection = 1 (hello), union = 3 (hello, world, there)
    expect(jaccardSimilarity("hello world", "hello there")).toBe(1 / 3);
  });

  it("filters stop words before computing similarity", () => {
    // "the quick brown fox" -> ["quick", "brown", "fox"]
    // "a quick brown dog" -> ["quick", "brown", "dog"]
    // intersection = 2 (quick, brown), union = 4 (quick, brown, fox, dog)
    expect(jaccardSimilarity("the quick brown fox", "a quick brown dog")).toBe(2 / 4);
  });

  it("preserves technical tokens in similarity computation", () => {
    // "tenant_id field" -> ["tenant_id", "field"]
    // "tenantId field" -> ["tenantId", "field"]
    // intersection = 1 (field), union = 3 (tenant_id, tenantId, field)
    expect(jaccardSimilarity("tenant_id field", "tenantId field")).toBe(1 / 3);
  });
});

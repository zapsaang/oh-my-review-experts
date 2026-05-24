import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/tools/secret-scanner.js";

function expectRedacted(original: string): void {
  const redacted = redactSecrets(original);

  expect(redacted).not.toBe(original);
  expect(redacted).toContain("[REDACTED");
}

function expectUnchanged(original: string): void {
  const redacted = redactSecrets(original);

  expect(redacted).toBe(original);
}

describe("redactSecrets pattern positives", () => {
  it("redacts AWS access key-shaped fake", () => {
    expectRedacted("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts GitHub token-shaped fake", () => {
    expectRedacted("ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts RSA private key-shaped fake", () => {
    expectRedacted("-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----");
  });

  it("redacts 40-character base64-shaped fake", () => {
    expectRedacted("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL+=");
  });

  it("redacts bearer token-shaped fake", () => {
    expectRedacted("bearer abcdefghijklmnopqrstuv");
  });

  it("redacts api_key-shaped fake", () => {
    expectRedacted("api_key=abcdefghijklmnop");
  });

  it("redacts access_token-shaped fake", () => {
    expectRedacted("access_token: abcdefghijklmnop.example");
  });

  it("redacts password-shaped fake", () => {
    expectRedacted("password=hunter22ABC");
  });

  it("redacts generic high-entropy-shaped fake", () => {
    expectRedacted("a".repeat(40));
  });
});

describe("redactSecrets pattern negatives", () => {
  it("leaves short AWS prefix unchanged", () => {
    expectUnchanged("AKIA");
  });

  it("leaves short GitHub token prefix unchanged", () => {
    expectUnchanged("ghp_short");
  });

  it("leaves private key discussion unchanged", () => {
    expectUnchanged("This document discusses RSA keys but contains none");
  });

  it("documents below-40 base64 fixture generic interaction", () => {
    expectRedacted("only 39 chars abcdefghijklmnopqrstuvwxyzABCDEFGHIJK");
  });

  it("leaves short bearer token unchanged", () => {
    expectUnchanged("bearer too_short");
  });

  it("leaves api_keyword assignment unchanged", () => {
    expectUnchanged("api_keyword=hello");
  });

  it("leaves access_tokenize text unchanged", () => {
    expectUnchanged("access_tokenize this");
  });

  it("leaves password reset sentence unchanged", () => {
    expectUnchanged("password reset link sent");
  });

  it("leaves short generic text unchanged", () => {
    expectUnchanged("hello world this is short");
  });
});

describe("redactSecrets overlap cases", () => {
  it("redacts input containing AWS key and base64-shaped fakes", () => {
    expectRedacted("AKIAIOSFODNN7EXAMPLE abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL+=");
  });

  it("redacts GitHub token fake long enough to match generic", () => {
    expectRedacted("ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts api_key fake followed by generic high-entropy fake", () => {
    expectRedacted("api_key=abcdefghijklmnop " + "b".repeat(40));
  });
});

describe("redactSecrets boundary tradeoffs (improved)", () => {
  it("redacts long alphanumeric filename with high entropy", () => {
    expectRedacted("long_alphanumeric_filename_with_underscores_and_dashes_test_xyz123");
  });

  it("leaves UUID unchanged", () => {
    expectUnchanged("123e4567-e89b-12d3-a456-426614174000");
  });

  it("leaves git hash unchanged", () => {
    expectUnchanged("abcdef0123456789abcdef0123456789abcdef01");
  });
});

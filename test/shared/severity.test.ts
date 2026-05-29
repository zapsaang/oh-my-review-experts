import { describe, it, expect } from "vitest";
import {
  SEVERITY_VALUES,
  SeverityLevel,
  severityRank,
  compareSeverity,
} from "../../src/shared/severity.js";

describe("SEVERITY_VALUES", () => {
  it("is exactly ['critical', 'high', 'medium', 'low']", () => {
    expect(SEVERITY_VALUES).toEqual(["critical", "high", "medium", "low"]);
  });
});

describe("severityRank", () => {
  it("maps critical to 0", () => {
    expect(severityRank.critical).toBe(0);
  });

  it("maps high to 1", () => {
    expect(severityRank.high).toBe(1);
  });

  it("maps medium to 2", () => {
    expect(severityRank.medium).toBe(2);
  });

  it("maps low to 3", () => {
    expect(severityRank.low).toBe(3);
  });
});

describe("compareSeverity", () => {
  it("returns negative when a outranks b", () => {
    expect(compareSeverity("critical", "high")).toBeLessThan(0);
    expect(compareSeverity("high", "medium")).toBeLessThan(0);
    expect(compareSeverity("medium", "low")).toBeLessThan(0);
    expect(compareSeverity("critical", "low")).toBeLessThan(0);
  });

  it("returns 0 for equal severities", () => {
    expect(compareSeverity("critical", "critical")).toBe(0);
    expect(compareSeverity("high", "high")).toBe(0);
    expect(compareSeverity("medium", "medium")).toBe(0);
    expect(compareSeverity("low", "low")).toBe(0);
  });

  it("returns positive when b outranks a", () => {
    expect(compareSeverity("high", "critical")).toBeGreaterThan(0);
    expect(compareSeverity("medium", "high")).toBeGreaterThan(0);
    expect(compareSeverity("low", "medium")).toBeGreaterThan(0);
    expect(compareSeverity("low", "critical")).toBeGreaterThan(0);
  });

  it("treats unknown severity as rank 4 (lowest)", () => {
    expect(compareSeverity("unknown", "critical")).toBeGreaterThan(0);
    expect(compareSeverity("critical", "unknown")).toBeLessThan(0);
    expect(compareSeverity("unknown", "low")).toBeGreaterThan(0);
    expect(compareSeverity("low", "unknown")).toBeLessThan(0);
    expect(compareSeverity("unknown", "also_unknown")).toBe(0);
  });
});

describe("SeverityLevel type", () => {
  it("accepts valid severity values at compile time", () => {
    const levels: SeverityLevel[] = ["critical", "high", "medium", "low"];
    expect(levels).toEqual(["critical", "high", "medium", "low"]);
  });
});

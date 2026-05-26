import { describe, it, expect } from "vitest";
import { sortKeysDeep, deterministicStringify } from "../../src/utils/deterministic-json.js";

describe("sortKeysDeep", () => {
  it("returns primitives unchanged", () => {
    expect(sortKeysDeep(null)).toBe(null);
    expect(sortKeysDeep(true)).toBe(true);
    expect(sortKeysDeep(false)).toBe(false);
    expect(sortKeysDeep(42)).toBe(42);
    expect(sortKeysDeep(3.14)).toBe(3.14);
    expect(sortKeysDeep("hello")).toBe("hello");
    expect(sortKeysDeep(undefined)).toBe(undefined);
  });

  it("sorts object keys alphabetically", () => {
    const input = { z: 1, a: 2, m: 3 };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
    expect(result.a).toBe(2);
    expect(result.m).toBe(3);
    expect(result.z).toBe(1);
  });

  it("produces same output regardless of insertion order", () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    expect(sortKeysDeep(a)).toEqual(sortKeysDeep(b));
  });

  it("recursively sorts nested objects", () => {
    const input = {
      b: { z: 1, a: 2 },
      a: { y: 3, x: 4 },
    };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.a as Record<string, unknown>)).toEqual(["x", "y"]);
    expect(Object.keys(result.b as Record<string, unknown>)).toEqual(["a", "z"]);
  });

  it("handles deeply nested objects", () => {
    const input = {
      outer: {
        z: {
          deep: 1,
          shallow: 2,
        },
        a: {
          beta: 3,
          alpha: 4,
        },
      },
    };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    const outer = result.outer as Record<string, unknown>;
    expect(Object.keys(outer)).toEqual(["a", "z"]);
    const z = outer.z as Record<string, unknown>;
    expect(Object.keys(z)).toEqual(["deep", "shallow"]);
    const a = outer.a as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(["alpha", "beta"]);
  });

  it("preserves arrays and processes their elements", () => {
    const input = {
      items: [
        { z: 1, a: 2 },
        { b: 3, a: 4 },
      ],
    };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Array.isArray(result.items)).toBe(true);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items.length).toBe(2);
    expect(Object.keys(items[0]!)).toEqual(["a", "z"]);
    expect(Object.keys(items[1]!)).toEqual(["a", "b"]);
  });

  it("preserves array order", () => {
    const input = [3, 1, 2];
    const result = sortKeysDeep(input) as number[];
    expect(result).toEqual([3, 1, 2]);
  });

  it("handles empty objects and arrays", () => {
    expect(sortKeysDeep({})).toEqual({});
    expect(sortKeysDeep([])).toEqual([]);
  });

  it("handles mixed nested structures", () => {
    const input = {
      z: [
        { c: 1, a: 2 },
        { b: 3, a: 4 },
      ],
      a: {
        y: [{ z: 1, a: 2 }],
        x: null,
      },
    };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "z"]);
    const a = result.a as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(["x", "y"]);
    expect(a.x).toBe(null);
    const y = a.y as Array<Record<string, unknown>>;
    expect(y.length).toBe(1);
    expect(Object.keys(y[0]!)).toEqual(["a", "z"]);
    const z = result.z as Array<Record<string, unknown>>;
    expect(z.length).toBe(2);
    expect(Object.keys(z[0]!)).toEqual(["a", "c"]);
    expect(Object.keys(z[1]!)).toEqual(["a", "b"]);
  });

  it("handles objects with symbol keys", () => {
    const sym = Symbol("test");
    const input: Record<string | symbol, unknown> = { z: 1, a: 2 };
    input[sym] = 3;
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "z"]);
    expect(result.a).toBe(2);
    expect(result.z).toBe(1);
  });

  it("preserves Date objects", () => {
    const date = new Date("2024-06-15T00:00:00.000Z");
    const result = sortKeysDeep(date);
    expect(result).toBe(date);
  });

  it("rejects RegExp objects", () => {
    expect(() => sortKeysDeep(/test/g)).toThrow(TypeError);
    expect(() => sortKeysDeep(/test/g)).toThrow("RegExp");
  });

  it("rejects Map objects", () => {
    expect(() => sortKeysDeep(new Map([["a", 1]]))).toThrow(TypeError);
    expect(() => sortKeysDeep(new Map())).toThrow("Map");
  });

  it("rejects Set objects", () => {
    expect(() => sortKeysDeep(new Set([1, 2, 3]))).toThrow(TypeError);
    expect(() => sortKeysDeep(new Set())).toThrow("Set");
  });

  it("rejects Error objects", () => {
    expect(() => sortKeysDeep(new Error("boom"))).toThrow(TypeError);
    expect(() => sortKeysDeep(new Error())).toThrow("Error");
  });

  it("rejects custom class instances", () => {
    class MyClass {
      z = 1;
      a = 2;
    }
    expect(() => sortKeysDeep(new MyClass())).toThrow(TypeError);
    expect(() => sortKeysDeep(new MyClass())).toThrow("MyClass");
  });

  it("handles null-prototype objects", () => {
    const input = Object.create(null);
    input.z = 1;
    input.a = 2;
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "z"]);
    expect(result.a).toBe(2);
    expect(result.z).toBe(1);
  });
});

describe("deterministicStringify", () => {
  it("produces consistent output regardless of insertion order", () => {
    const a = { z: 1, a: 2 };
    const b = { a: 2, z: 1 };
    expect(deterministicStringify(a)).toBe(deterministicStringify(b));
  });

  it("formats with 2-space indentation", () => {
    const input = { a: 1 };
    const output = deterministicStringify(input);
    expect(output).toBe("{\n  \"a\": 1\n}\n");
  });

  it("ends with a newline", () => {
    const input = { a: 1 };
    const output = deterministicStringify(input);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("handles nested objects with stable formatting", () => {
    const input = {
      b: { z: 1, a: 2 },
      a: { y: 3, x: 4 },
    };
    const output = deterministicStringify(input);
    const expected = `{
  "a": {
    "x": 4,
    "y": 3
  },
  "b": {
    "a": 2,
    "z": 1
  }
}
`;
    expect(output).toBe(expected);
  });

  it("handles arrays in objects", () => {
    const input = {
      items: [3, 1, 2],
    };
    const output = deterministicStringify(input);
    const expected = `{
  "items": [
    3,
    1,
    2
  ]
}
`;
    expect(output).toBe(expected);
  });

  it("handles null and primitives", () => {
    expect(deterministicStringify(null)).toBe("null\n");
    expect(deterministicStringify(true)).toBe("true\n");
    expect(deterministicStringify(42)).toBe("42\n");
    expect(deterministicStringify("hello")).toBe('"hello"\n');
  });

  it("handles empty objects and arrays", () => {
    expect(deterministicStringify({})).toBe("{}\n");
    expect(deterministicStringify([])).toBe("[]\n");
  });

  it("formats Date objects via JSON.stringify", () => {
    const date = new Date("2024-06-15T00:00:00.000Z");
    const output = deterministicStringify({ createdAt: date });
    expect(output).toContain('"createdAt": "2024-06-15T00:00:00.000Z"');
  });

  it("propagates TypeError for non-plain objects", () => {
    expect(() => deterministicStringify(new Map())).toThrow(TypeError);
    expect(() => deterministicStringify(/test/)).toThrow("RegExp");
  });
});

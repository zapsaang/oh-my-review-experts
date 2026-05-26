/**
 * Deterministic JSON utilities.
 *
 * Recursively sorts object keys to produce stable JSON output regardless
 * of insertion order. Used for schema generation/checking to avoid drift
 * caused by Zod internal ordering changes.
 */

function isPlainObject(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

export function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep);
  }
  if (obj instanceof Date) {
    return obj;
  }
  if (obj && typeof obj === "object") {
    if (!isPlainObject(obj)) {
      throw new TypeError(
        `Cannot deterministically serialize non-plain object: ${obj.constructor?.name ?? "[unknown]"}`,
      );
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return obj;
}

export function deterministicStringify(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj), null, 2) + "\n";
}

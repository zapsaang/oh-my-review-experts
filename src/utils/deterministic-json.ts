/**
 * Deterministic JSON utilities.
 *
 * Recursively sorts object keys to produce stable JSON output regardless
 * of insertion order. Used for schema generation/checking to avoid drift
 * caused by Zod internal ordering changes.
 */

export function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep);
  }
  if (obj && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

export function deterministicStringify(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj), null, 2) + "\n";
}

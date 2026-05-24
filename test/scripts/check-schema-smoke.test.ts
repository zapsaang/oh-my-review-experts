import { describe, it, expect } from "vitest";
import { runCheckSchema } from "../../scripts/check-schema.js";

describe("schema smoke", () => {
  it("tracked schema matches generated schema", () => {
    const result = runCheckSchema();
    if (!result.ok) {
      console.error("Schema drift detected. Run: npm run generate-schema");
      console.error(result.diff);
    }
    expect(result.ok).toBe(true);
  });
});

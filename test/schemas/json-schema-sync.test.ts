import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ModelConfig, OmreConfigSchema } from "../../src/config/schema.js";

const SCHEMA_PATH = path.resolve(__dirname, "../../schemas/oh-my-review-experts.schema.json");

describe("[step 19] models.orchestrator deprecation marker", () => {
  it("Zod schema description for models.orchestrator starts with [DEPRECATED", () => {
    const orchestratorField = ModelConfig.shape.orchestrator;
    const description = orchestratorField.description;
    expect(description).toBeDefined();
    expect(description!.startsWith("[DEPRECATED")).toBe(true);
  });

  it("JSON Schema marks models.orchestrator as deprecated and updates its description", () => {
    const raw = fs.readFileSync(SCHEMA_PATH, "utf-8");
    const schema = JSON.parse(raw);
    const orchestrator = schema?.properties?.models?.properties?.orchestrator;
    expect(orchestrator).toBeDefined();
    expect(orchestrator.deprecated).toBe(true);
    expect(typeof orchestrator.description).toBe("string");
    expect(orchestrator.description.startsWith("[DEPRECATED")).toBe(true);
  });

  it("does not break parsing — models.orchestrator field is still accepted", () => {
    const parsed = OmreConfigSchema.parse({
      models: { orchestrator: "some-model/v1" },
    });
    expect(parsed.models.orchestrator).toBe("some-model/v1");
  });
});

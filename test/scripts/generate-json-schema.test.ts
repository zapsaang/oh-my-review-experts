import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_FILE = "oh-my-review-experts.schema.json";

describe("generated JSON schema", () => {
  const schemaPath = path.join(process.cwd(), "schemas", SCHEMA_FILE);

  it("exists and is valid JSON", () => {
    const content = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
  });

  it("schema file is referenced by load-config", () => {
    const loadConfigPath = path.join(process.cwd(), "src", "config", "load-config.ts");
    const loadConfigContent = fs.readFileSync(loadConfigPath, "utf8");
    expect(loadConfigContent).toContain(SCHEMA_FILE);
  });

  it("contains command name constraints including forbidden names", () => {
    const content = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content);
    const commandSchema = schema.properties?.command;
    expect(commandSchema).toBeDefined();
    expect(commandSchema.properties?.name).toBeDefined();
    expect(commandSchema.properties?.name?.pattern).toBe("^[a-zA-Z0-9_-]+$");
    expect(commandSchema.properties?.name?.not?.enum).toContain("__proto__");
    expect(commandSchema.properties?.name?.not?.enum).toContain("constructor");
    expect(commandSchema.properties?.name?.not?.enum).toContain("prototype");
    expect(commandSchema.properties?.aliases?.items?.not?.enum).toContain("__proto__");
    expect(commandSchema.properties?.aliases?.items?.not?.enum).toContain("constructor");
    expect(commandSchema.properties?.aliases?.items?.not?.enum).toContain("prototype");
  });

  it("accepts partial configs by having no required fields anywhere", () => {
    const content = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content);

    function assertNoRequired(obj: unknown, path: string): void {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach((item, i) => assertNoRequired(item, `${path}[${i}]`));
        return;
      }
      const record = obj as Record<string, unknown>;
      expect(record.required, `unexpected required at ${path}`).toBeUndefined();
      for (const [key, value] of Object.entries(record)) {
        assertNoRequired(value, `${path}.${key}`);
      }
    }
    assertNoRequired(schema, "schema");

    // Verify top-level sections exist as properties (so partial configs are structurally valid)
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties)).toContain("command");
    expect(Object.keys(schema.properties)).toContain("agents");
  });

  it("contains report directory path constraints", () => {
    const content = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content);
    const reportSchema = schema.properties?.report;
    expect(reportSchema).toBeDefined();
    expect(reportSchema.properties?.directory).toBeDefined();
  });

  it("schemas directory contains exactly one schema file", () => {
    const schemasDir = path.join(process.cwd(), "schemas");
    const files = fs.readdirSync(schemasDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(SCHEMA_FILE);
  });

  it("has $id, title, and description at root", () => {
    const content = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content);
    expect(schema.$id).toBeDefined();
    expect(schema.title).toBeDefined();
    expect(schema.description).toBeDefined();
  });

  it("every top-level property has a description", () => {
    const content = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(content);
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      expect((value as Record<string, unknown>).description, `${key} missing description`).toBeTypeOf("string");
    }
  });

  it("does not emit MAX_SAFE_INTEGER as artificial maximum", () => {
    const content = fs.readFileSync(schemaPath, "utf8");
    expect(content).not.toContain("9007199254740991");
  });
});

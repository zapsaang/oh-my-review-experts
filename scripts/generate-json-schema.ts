import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toJSONSchema } from "zod";
import { OmreConfigSchema } from "../src/config/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const jsonSchema = toJSONSchema(OmreConfigSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Post-process: add forbidden command names constraint that refine() cannot express
const properties = isRecord(jsonSchema) ? jsonSchema.properties : undefined;
const command = isRecord(properties) ? properties.command : undefined;
const commandProps = isRecord(command) ? command.properties : undefined;

const nameSchema = isRecord(commandProps) ? commandProps.name : undefined;
if (isRecord(nameSchema)) {
  nameSchema.not = { enum: ["__proto__", "constructor", "prototype"] };
}

const aliases = isRecord(commandProps) ? commandProps.aliases : undefined;
const aliasItems = isRecord(aliases) ? aliases.items : undefined;
if (isRecord(aliasItems)) {
  aliasItems.not = { enum: ["__proto__", "constructor", "prototype"] };
}

const models = isRecord(properties) ? properties.models : undefined;
const modelsProps = isRecord(models) ? models.properties : undefined;
const orchestratorProp = isRecord(modelsProps) ? modelsProps.orchestrator : undefined;
if (isRecord(orchestratorProp)) {
  orchestratorProp.deprecated = true;
}

// Post-process: remove all nested "required" arrays.
// Runtime config loading uses .default() on every top-level section, so partial
// configs like { "command": { "name": "review" } } must be accepted.
// Zod's toJSONSchema emits required[] for object fields even when the parent
// object has .default() — we strip them to align JSON Schema with runtime.
function stripRequired(obj: unknown): void {
  if (!isRecord(obj)) {
    if (Array.isArray(obj)) {
      for (const item of obj) stripRequired(item);
    }
    return;
  }
  delete obj.required;
  for (const value of Object.values(obj)) {
    stripRequired(value);
  }
}
stripRequired(jsonSchema);

const outputPath = path.join(__dirname, "..", "schemas", "oh-my-review-experts.schema.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2), "utf8");

console.log(`JSON Schema written to ${outputPath}`);

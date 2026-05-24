import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toJSONSchema } from "zod";
import { OmreConfigSchema } from "../src/config/schema.js";
import { deterministicStringify } from "../src/utils/deterministic-json.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateSchema(): string {
  const jsonSchema = toJSONSchema(OmreConfigSchema);

  // Post-process: add forbidden command names constraint
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

  // Post-process: remove all nested "required" arrays
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

  return deterministicStringify(jsonSchema);
}

function makeDiff(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxLen = Math.max(aLines.length, bLines.length);
  const diff: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const al = aLines[i] ?? "";
    const bl = bLines[i] ?? "";
    if (al !== bl) {
      diff.push(`- ${al}`);
      diff.push(`+ ${bl}`);
    }
  }
  return diff.join("\n");
}

export function runCheckSchema(
  trackedContent?: string,
  generatedContent?: string
): { ok: boolean; message?: string; diff?: string } {
  const tracked =
    trackedContent !== undefined
      ? deterministicStringify(JSON.parse(trackedContent))
      : (() => {
          const schemaPath = path.join(__dirname, "..", "schemas", "oh-my-review-experts.schema.json");
          const raw = fs.readFileSync(schemaPath, "utf8");
          return deterministicStringify(JSON.parse(raw));
        })();

  const generated =
    generatedContent !== undefined
      ? deterministicStringify(JSON.parse(generatedContent))
      : generateSchema();

  if (tracked === generated) {
    return { ok: true, message: "check-schema: OK" };
  }

  return {
    ok: false,
    message: "check-schema: FAILED - schema drift detected",
    diff: makeDiff(tracked, generated),
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runCheckSchema();
  if (result.ok) {
    console.log(result.message);
    process.exit(0);
  } else {
    console.error(result.message);
    if (result.diff) {
      console.error("\nDiff (tracked vs generated):\n");
      console.error(result.diff);
    }
    process.exit(1);
  }
}

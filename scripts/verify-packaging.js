#!/usr/bin/env node
/**
 * Post-build packaging verification.
 * Run after `npm run build` to ensure dist/ output meets packaging requirements.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "..", "dist", "index.js");

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`✅ ${message}`);
}

// Verify dist/index.js exists
if (!fs.existsSync(distPath)) {
  fail("dist/index.js not found. Run npm run build first.");
}

const content = fs.readFileSync(distPath, "utf8");

// Requirement 1: No runtime import of @opencode-ai/plugin
const hasPluginImport =
  content.includes('from "@opencode-ai/plugin"') ||
  content.includes("from '@opencode-ai/plugin'");
if (hasPluginImport) {
  fail("dist/index.js contains runtime import of @opencode-ai/plugin (must be type-only import)");
}
ok("No runtime import of @opencode-ai/plugin");

// Requirement 2: Contains local tool wrapper
if (!content.includes("function tool(input)")) {
  fail("dist/index.js does not contain local tool wrapper");
}
ok("Local tool wrapper present");

// Requirement 3: Verify schema files
const schemasDir = path.join(__dirname, "..", "schemas");
const schemaFiles = fs.readdirSync(schemasDir).filter((f) => f.endsWith(".json"));
if (schemaFiles.length !== 1) {
  fail(`Expected exactly one schema file in schemas/, found: ${schemaFiles.join(", ")}`);
}
if (schemaFiles[0] !== "oh-my-review-experts.schema.json") {
  fail(`Unexpected schema file: ${schemaFiles[0]}`);
}
ok("Exactly one schema file: oh-my-review-experts.schema.json");

console.log("\n✅ All packaging checks passed");

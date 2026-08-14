import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicOverwrite } from "../tools/fs-utils.js";

export interface RunMeta {
  withMemory: boolean;
  noMemory: boolean;
}

export function writeRunMeta(handoffDir: string, meta: RunMeta): string {
  const filePath = path.join(handoffDir, ".run-meta.json");
  const content = JSON.stringify(meta);
  writeFileAtomicOverwrite(filePath, content);
  return filePath;
}

export function readRunMeta(handoffDir: string): RunMeta | undefined {
  const filePath = path.join(handoffDir, ".run-meta.json");
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, { encoding: "utf8" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error("readRunMeta: failed to read run metadata", { cause: error });
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("readRunMeta: invalid JSON in run metadata", { cause: error });
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  return {
    withMemory: obj.withMemory === true,
    noMemory: obj.noMemory === true,
  };
}

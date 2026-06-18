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
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  let data: unknown;
  try {
    const raw = fs.readFileSync(filePath, { encoding: "utf8" });
    data = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
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

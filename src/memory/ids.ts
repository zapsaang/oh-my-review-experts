import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";

export function generateMemoryFindingId(): string {
  return `mem_${randomBytes(16).toString("hex")}`;
}

export function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

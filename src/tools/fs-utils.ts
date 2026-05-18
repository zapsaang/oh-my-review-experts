import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function assertSafePath(resolvedPath: string, basePath: string, context: string): void {
  const normalizedResolved = path.normalize(resolvedPath);
  const normalizedBase = path.normalize(basePath);
  const safePrefix = normalizedBase.endsWith(path.sep) ? normalizedBase : normalizedBase + path.sep;
  if (normalizedResolved !== normalizedBase && !normalizedResolved.startsWith(safePrefix)) {
    throw new Error(
      `Path traversal blocked: ${context} resolved to "${normalizedResolved}" which escapes base "${normalizedBase}". ` +
      `Ensure the path is a safe relative path within the project.`,
    );
  }
}

export function writeFileAtomic(filePath: string, content: string, maxAttempts = 10): string {
  let attempt = 0;
  while (attempt < maxAttempts) {
    const attemptPath =
      attempt === 0
        ? filePath
        : filePath.replace(/(\.[^.]+)$/, `-${attempt}$1`);
    try {
      fs.writeFileSync(attemptPath, content, { flag: "wx", encoding: "utf8" });
      return attemptPath;
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
        attempt++;
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Failed to write file after ${maxAttempts} attempts due to filename collisions`,
  );
}

export function writeFileAtomicOverwrite(filePath: string, content: string): void {
  const tmpFile = makeTempPath(filePath);
  try {
    fs.writeFileSync(tmpFile, content, { flag: "wx", encoding: "utf8" });
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { }
    throw err;
  }
}

export function makeTempPath(targetPath: string): string {
  return `${targetPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
}

export function formatTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad3(d.getMilliseconds())}`;
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePackageIdentity } from "../../src/memory/package-resolver.js";

describe("resolvePackageIdentity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-package-resolver-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): string {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  function writeJson(relativePath: string, value: object): string {
    return writeFile(relativePath, `${JSON.stringify(value)}\n`);
  }

  function resolve(relativePath: string) {
    return resolvePackageIdentity(path.join(tmpDir, relativePath), tmpDir);
  }

  it("returns repo-root with low confidence when no marker is found", () => {
    const result = resolve("src/index.ts");

    expect(result).toEqual({
      packageKind: "repo-root",
      packagePath: ".",
      confidence: "low",
    });
  });

  it("detects a workspace-root from package.json with a workspaces array", () => {
    writeJson("package.json", { name: "root", workspaces: ["packages/*"] });

    const result = resolve("packages/auth/src/index.ts");

    expect(result).toEqual({
      packageKind: "workspace-root",
      packageName: "root",
      packagePath: ".",
      confidence: "high",
    });
  });

  it.each([
    ["pnpm-workspace.yaml", "packages:\n  - packages/*\n"],
    ["lerna.json", "{}\n"],
    ["turbo.json", "{}\n"],
    ["nx.json", "{}\n"],
  ])("detects %s as a workspace-root marker", (markerFile, content) => {
    writeFile(markerFile, content);

    const result = resolve("src/index.ts");

    expect(result).toEqual({
      packageKind: "workspace-root",
      packagePath: ".",
      confidence: "high",
    });
  });

  it("detects a workspace-package for nested package.json under a workspace root", () => {
    writeJson("package.json", { name: "root", workspaces: ["packages/*"] });
    writeJson("packages/auth/package.json", { name: "@scope/auth" });

    const result = resolve("packages/auth/src/foo.ts");

    expect(result).toEqual({
      packageKind: "workspace-package",
      packageName: "@scope/auth",
      packagePath: path.join("packages", "auth"),
      confidence: "high",
    });
  });

  it.each(["go.mod", "Cargo.toml", "pom.xml", "build.gradle"])(
    "detects %s as a standalone-package marker",
    (markerFile) => {
      writeFile(path.join("services", "api", markerFile), "marker\n");

      const result = resolve("services/api/src/main.txt");

      expect(result).toEqual({
        packageKind: "standalone-package",
        packagePath: path.join("services", "api"),
        confidence: "high",
      });
    },
  );

  it("finds the nearest marker for nested files", () => {
    writeFile("go.mod", "module example.com/root\n");
    writeJson("apps/web/package.json", { name: "web" });

    const result = resolve("apps/web/src/deep/page.ts");

    expect(result).toEqual({
      packageKind: "standalone-package",
      packageName: "web",
      packagePath: path.join("apps", "web"),
      confidence: "high",
    });
  });

  it("handles malformed package.json without throwing", () => {
    writeFile("package.json", "not json {\n");

    expect(() => resolve("foo.ts")).not.toThrow();
    expect(resolve("foo.ts")).toEqual({
      packageKind: "repo-root",
      packagePath: ".",
      confidence: "low",
    });
  });
});

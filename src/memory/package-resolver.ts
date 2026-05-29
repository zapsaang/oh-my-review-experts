import fs from "node:fs";
import path from "node:path";

export type PackageKind = "repo-root" | "workspace-root" | "workspace-package" | "standalone-package" | "unknown";
export type PackageConfidence = "high" | "medium" | "low";

export interface PackageIdentity {
  packageKind: PackageKind;
  packageName?: string;
  packagePath: string;
  confidence: PackageConfidence;
}

export interface PackageMarker {
  file: string;
  kind: PackageKind;
  confidence: PackageConfidence;
}

export interface PackageMarkerMatch {
  marker: PackageMarker;
  markerPath: string;
  packageRoot: string;
  packageName?: string;
}

export const PACKAGE_MARKERS: PackageMarker[] = [
  { file: "package.json", kind: "standalone-package", confidence: "high" },
  { file: "pnpm-workspace.yaml", kind: "workspace-root", confidence: "high" },
  { file: "lerna.json", kind: "workspace-root", confidence: "high" },
  { file: "turbo.json", kind: "workspace-root", confidence: "high" },
  { file: "nx.json", kind: "workspace-root", confidence: "high" },
  { file: "go.mod", kind: "standalone-package", confidence: "high" },
  { file: "Cargo.toml", kind: "standalone-package", confidence: "high" },
  { file: "pom.xml", kind: "standalone-package", confidence: "high" },
  { file: "build.gradle", kind: "standalone-package", confidence: "high" },
];

interface PackageJsonInfo {
  hasWorkspaces: boolean;
  packageName?: string;
}

const PACKAGE_JSON_MARKER = markerFor("package.json");

const WORKSPACE_MARKERS = PACKAGE_MARKERS.filter(
  (marker) => marker.kind === "workspace-root" && marker.file !== "package.json",
);

const STANDALONE_MARKERS = PACKAGE_MARKERS.filter(
  (marker) => marker.kind === "standalone-package" && marker.file !== "package.json",
);

export function isWorkspaceRoot(dirPath: string): boolean {
  const packageJson = readPackageJsonInfo(path.join(dirPath, "package.json"));
  if (packageJson?.hasWorkspaces === true) {
    return true;
  }

  return WORKSPACE_MARKERS.some((marker) => fs.existsSync(path.join(dirPath, marker.file)));
}

export function findNearestPackageMarker(startDir: string, repoRoot: string): PackageMarkerMatch | undefined {
  const resolvedRepoRoot = path.resolve(repoRoot);
  let currentDir = path.resolve(startDir);

  while (isWithinOrEqual(currentDir, resolvedRepoRoot)) {
    const match = findMarkerInDirectory(currentDir);
    if (match !== undefined) {
      return match;
    }

    if (currentDir === resolvedRepoRoot) {
      break;
    }

    currentDir = path.dirname(currentDir);
  }

  return undefined;
}

export function resolvePackageIdentity(filePath: string, repoRoot: string): PackageIdentity {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const startDir = resolveStartDirectory(filePath, resolvedRepoRoot);
  const match = findNearestPackageMarker(startDir, resolvedRepoRoot);

  if (match === undefined) {
    return {
      packageKind: "repo-root",
      packagePath: relativePackagePath(resolvedRepoRoot, resolvedRepoRoot),
      confidence: "low",
    };
  }

  if (match.marker.kind === "workspace-root") {
    return identityFromMatch(match, resolvedRepoRoot, "workspace-root", match.marker.confidence);
  }

  if (match.marker.file === "package.json") {
    const workspaceRoot = findNearestWorkspaceRoot(path.dirname(match.packageRoot), resolvedRepoRoot);
    const packageKind: PackageKind = workspaceRoot === undefined ? "standalone-package" : "workspace-package";

    return identityFromMatch(match, resolvedRepoRoot, packageKind, match.marker.confidence);
  }

  return identityFromMatch(match, resolvedRepoRoot, match.marker.kind, match.marker.confidence);
}

function findMarkerInDirectory(dirPath: string): PackageMarkerMatch | undefined {
  const packageJsonPath = path.join(dirPath, "package.json");
  const packageJson = readPackageJsonInfo(packageJsonPath);

  if (packageJson?.hasWorkspaces === true) {
    return {
      marker: { ...PACKAGE_JSON_MARKER, kind: "workspace-root" },
      markerPath: packageJsonPath,
      packageRoot: dirPath,
      packageName: packageJson.packageName,
    };
  }

  const workspaceMarker = findExistingMarker(dirPath, WORKSPACE_MARKERS);
  if (workspaceMarker !== undefined) {
    return workspaceMarker;
  }

  if (packageJson !== undefined) {
    return {
      marker: PACKAGE_JSON_MARKER,
      markerPath: packageJsonPath,
      packageRoot: dirPath,
      packageName: packageJson.packageName,
    };
  }

  return findExistingMarker(dirPath, STANDALONE_MARKERS);
}

function findExistingMarker(dirPath: string, markers: PackageMarker[]): PackageMarkerMatch | undefined {
  for (const marker of markers) {
    const markerPath = path.join(dirPath, marker.file);
    if (fs.existsSync(markerPath)) {
      return {
        marker,
        markerPath,
        packageRoot: dirPath,
      };
    }
  }

  return undefined;
}

function findNearestWorkspaceRoot(startDir: string, repoRoot: string): string | undefined {
  let currentDir = path.resolve(startDir);
  const resolvedRepoRoot = path.resolve(repoRoot);

  while (isWithinOrEqual(currentDir, resolvedRepoRoot)) {
    if (isWorkspaceRoot(currentDir)) {
      return currentDir;
    }

    if (currentDir === resolvedRepoRoot) {
      break;
    }

    currentDir = path.dirname(currentDir);
  }

  return undefined;
}

function readPackageJsonInfo(packageJsonPath: string): PackageJsonInfo | undefined {
  if (!fs.existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
    return {
      hasWorkspaces: hasWorkspaceDeclaration(parsed),
      packageName: readStringProperty(parsed, "name"),
    };
  } catch {
    // Malformed package.json — skip and let the caller try the next marker
    return undefined;
  }
}

function hasWorkspaceDeclaration(value: unknown): boolean {
  const workspaces = readProperty(value, "workspaces");
  if (Array.isArray(workspaces)) {
    return true;
  }

  return Array.isArray(readProperty(workspaces, "packages"));
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" && property.length > 0 ? property : undefined;
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
}

function resolveStartDirectory(filePath: string, repoRoot: string): string {
  const resolvedPath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(repoRoot, filePath);

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    return resolvedPath;
  }

  return path.dirname(resolvedPath);
}

function identityFromMatch(
  match: PackageMarkerMatch,
  repoRoot: string,
  packageKind: PackageKind,
  confidence: PackageConfidence,
): PackageIdentity {
  const identity: PackageIdentity = {
    packageKind,
    packagePath: relativePackagePath(repoRoot, match.packageRoot),
    confidence,
  };

  if (match.packageName !== undefined) {
    identity.packageName = match.packageName;
  }

  return identity;
}

function relativePackagePath(repoRoot: string, packageRoot: string): string {
  const relativePath = path.relative(repoRoot, packageRoot);
  return relativePath === "" ? "." : relativePath;
}

function isWithinOrEqual(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function markerFor(file: string): PackageMarker {
  const marker = PACKAGE_MARKERS.find((candidate) => candidate.file === file);
  if (marker === undefined) {
    throw new Error(`Unknown package marker: ${file}`);
  }

  return marker;
}

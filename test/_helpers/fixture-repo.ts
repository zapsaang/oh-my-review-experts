import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function gitCommit(cwd: string, message: string) {
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd, stdio: "ignore" }
  );
}

export function withCleanGitRepo<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-review-prompt-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".omre/\nnode_modules/\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function withRepoOnBranch<T>(
  branchName: string,
  files: Record<string, string>,
  fn: (cwd: string) => T
): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-branch-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add files");

    execFileSync("git", ["checkout", "-b", branchName], { cwd: tmpDir, stdio: "ignore" });
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function withRepoWithBranches<T>(
  branches: Record<string, Record<string, string>>,
  fn: (cwd: string) => T
): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-branches-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    for (const [branchName, files] of Object.entries(branches)) {
      execFileSync("git", ["checkout", "-b", branchName], { cwd: tmpDir, stdio: "ignore" });
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(tmpDir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf8");
      }
      execFileSync("git", ["add", "."], { cwd: tmpDir, stdio: "ignore" });
      gitCommit(tmpDir, `add files on ${branchName}`);
    }

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function withRepoWithStagedFile<T>(
  file: string,
  content: string,
  fn: (cwd: string) => T
): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-staged-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    const fullPath = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    execFileSync("git", ["add", file], { cwd: tmpDir, stdio: "ignore" });

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function withRepoWithSecret<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-secret-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    const secretContent = "AKIAIOSFODNN7EXAMPLE is my aws key\n";
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), secretContent, "utf8");
    execFileSync("git", ["add", "secret.txt"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add secret");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function withHierarchicalRepo<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-hier-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), ".omre/\nnode_modules/\n", "utf8");
    fs.mkdirSync(path.join(tmpDir, ".omre"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".omre", "config.json"),
      JSON.stringify({
        costGuardrail: { compactModeThreshold: 100 },
        arbitration: { hierarchicalThreshold: 3 },
      }),
      "utf8"
    );
    fs.mkdirSync(path.join(tmpDir, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "payment"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "user"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "auth", "login.ts"), "// auth\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "src", "payment", "process.ts"), "// payment\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "src", "user", "profile.ts"), "// user\n", "utf8");
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function withRepoWithOversizedDiff<T>(fn: (cwd: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omre-oversized-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "init");

    // Generate ~250KB of deterministic content.
    // Use a pattern that breaks secret-scanner regex runs (>31 alphanumeric chars)
    // so truncation tests are not silently defeated by redaction shrinking the diff.
    const line = ("x".repeat(31) + " ").repeat(3) + "x".repeat(7) + "\n";
    const linesNeeded = Math.ceil((250 * 1024) / line.length);
    const content = line.repeat(linesNeeded);
    fs.writeFileSync(path.join(tmpDir, "large.txt"), content, "utf8");
    execFileSync("git", ["add", "large.txt"], { cwd: tmpDir, stdio: "ignore" });
    gitCommit(tmpDir, "add oversized file");

    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

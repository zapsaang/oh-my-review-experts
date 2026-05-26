import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCliProgram, runDoctor, type DoctorContractChecks } from "../src/cli.js";
import { AmbiguousScopeError } from "../src/workflow/scope-resolver.js";
import * as scopeResolver from "../src/workflow/scope-resolver.js";

const ansiPattern = /\x1B\[[0-9;]*m/g;
const originalExitCode = process.exitCode;

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

function captureOutput() {
  const lines: string[] = [];
  return {
    lines,
    output: {
      log: (...values: unknown[]) => { lines.push(values.join(" ")); },
      error: (...values: unknown[]) => { lines.push(values.join(" ")); },
    },
  };
}

const cleanContractChecks: DoctorContractChecks = {
  checkPromptExampleSchemaIdentity: () => [],
  checkAgentToolWhitelist: () => [],
};

describe("doctor CLI", () => {
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("prints the contract self-check section with green status lines when checks are clean", () => {
    process.exitCode = undefined;
    const captured = captureOutput();

    runDoctor({ cwd: ".", output: captured.output, contractChecks: cleanContractChecks });

    const text = stripAnsi(captured.lines.join("\n"));
    expect(text).toContain("Contract self-check:");
    expect(text).toContain("  prompt JSON examples match Zod schemas  ✓");
    expect(text).toContain("  agent tool whitelists clean             ✓");
    expect(process.exitCode).toBeUndefined();
  });

  it("sets process.exitCode to 2 and prints injected warnings when either contract check warns", () => {
    process.exitCode = undefined;
    const captured = captureOutput();
    const warningChecks: DoctorContractChecks = {
      checkPromptExampleSchemaIdentity: () => ["fake prompt violation"],
      checkAgentToolWhitelist: () => [],
    };

    runDoctor({ cwd: ".", output: captured.output, contractChecks: warningChecks });

    const text = stripAnsi(captured.lines.join("\n"));
    expect(process.exitCode).toBe(2);
    expect(text).toContain("  prompt JSON examples match Zod schemas  ✗");
    expect(text).toContain("  agent tool whitelists clean             ✓");
    expect(text).toContain("  fake prompt violation");
  });

  it("documents all doctor CI exit codes in help text", () => {
    const doctorCommand = createCliProgram().commands.find((command) => command.name() === "doctor");

    const helpText = stripAnsi(doctorCommand?.helpInformation() ?? "").replace(/\s+/g, " ");

    expect(helpText).toContain(
      "CI exit codes: 0 clean, 1 doctor errored, 2 contract self-check failed",
    );
  });

describe("doctor agent runtime models table", () => {
    it("shows all agents with default source when no config", () => {
      const captured = captureOutput();
      const tmpDir = fs.mkdtempSync(".omre-doctor-test-");
      try {
        runDoctor({ cwd: tmpDir, output: captured.output, contractChecks: cleanContractChecks });
        const text = stripAnsi(captured.lines.join("\n"));
        expect(text).toContain("Agent runtime models:");
        expect(text).toContain("Agent");
        expect(text).toContain("Model");
        expect(text).toContain("Tier");
        expect(text).toContain("Parameters");
        expect(text).toContain("Source");
        expect(text).toContain("default");
        expect(text).toContain("omre-reviewer-spec");
        expect(text).toContain("omre-reviewer-quality");
        expect(text).toContain("omre-reviewer-security");
        expect(text).toContain("omre-reviewer-performance");
        expect(text).toContain("omre-reviewer-concurrency");
        expect(text).toContain("omre-slice-planner");
        expect(text).toContain("omre-slice-plan-validator");
        expect(text).toContain("omre-result-validator");
        expect(text).toContain("omre-slice-arbiter");
        expect(text).toContain("omre-global-arbiter");
        expect(text).toContain("omre-report-writer");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("shows config source for explicitly configured agents", () => {
      const captured = captureOutput();
      const tmpDir = fs.mkdtempSync(".omre-doctor-test-");
      const omreConfigPath = path.join(tmpDir, ".opencode");
      fs.mkdirSync(omreConfigPath, { recursive: true });
      fs.writeFileSync(
        path.join(omreConfigPath, "oh-my-review-experts.jsonc"),
        JSON.stringify({ agents: { "omre-reviewer-spec": { model: "a/b" } } }),
        "utf8"
      );

      try {
        runDoctor({ cwd: tmpDir, output: captured.output, contractChecks: cleanContractChecks });
        const text = stripAnsi(captured.lines.join("\n"));
        expect(text).toContain("Agent runtime models:");
        // "config" must appear in the table as a Source value, not just in "Config files:"
        const tableSection = text.split("Agent runtime models:")[1]?.split("Provider inference:")[0] ?? "";
        expect(tableSection).toContain("config");
        expect(text).toContain("default");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not show provider inference section", () => {
      const captured = captureOutput();
      const tmpDir = fs.mkdtempSync(".omre-doctor-test-");
      const opencodePath = path.join(tmpDir, "opencode.json");
      fs.writeFileSync(opencodePath, JSON.stringify({ model: "anthropic/claude-opus-4-7" }), "utf8");

      try {
        runDoctor({ cwd: tmpDir, output: captured.output, contractChecks: cleanContractChecks });
        const text = stripAnsi(captured.lines.join("\n"));
        expect(text).not.toContain("Inferred provider");
        expect(text).not.toContain("Provider inference");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("warns when agent is configured in both opencode.json and OMRE config", () => {
      const captured = captureOutput();
      const tmpDir = fs.mkdtempSync(".omre-doctor-test-");
      const opencodePath = path.join(tmpDir, "opencode.json");
      fs.writeFileSync(
        opencodePath,
        JSON.stringify({
          model: "anthropic/claude-opus-4-7",
          agents: { "omre-reviewer-spec": { model: "openai/gpt-5.5" } },
        }),
        "utf8"
      );
      const omreConfigPath = path.join(tmpDir, ".opencode");
      fs.mkdirSync(omreConfigPath, { recursive: true });
      fs.writeFileSync(
        path.join(omreConfigPath, "oh-my-review-experts.jsonc"),
        JSON.stringify({ agents: { "omre-reviewer-spec": { model: "a/b" } } }),
        "utf8"
      );

      try {
        runDoctor({ cwd: tmpDir, output: captured.output, contractChecks: cleanContractChecks });
        const text = stripAnsi(captured.lines.join("\n"));
        expect(text).toMatch(/warn/i);
        expect(text).toMatch(/configured in both|opencode\.json/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe("dry-run CLI", () => {
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("exits 1 with error message for invalid scope", () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const program = createCliProgram();
      expect(() => {
        program.parse(["node", "omre", "dry-run", "path:/etc/passwd"]);
      }).toThrow("EXIT_1");

      const errorCall = errorSpy.mock.calls[0]?.[0] as string;
      expect(errorCall).toContain("Error:");
      expect(errorCall).toContain("Absolute path not allowed");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("exits 1 with formatted ambiguous scope error", () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT_${code}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const parseSpy = vi.spyOn(scopeResolver, 'parseReviewScope').mockImplementation(() => {
      throw new AmbiguousScopeError(
        'Input "auth" is ambiguous (matches both a branch and a path). Use explicit prefix: branch:auth or path:auth',
        [
          { kind: "branch", name: "auth" },
          { kind: "paths", paths: ["auth"] },
        ]
      );
    });

    try {
      const program = createCliProgram();
      expect(() => {
        program.parse(["node", "omre", "dry-run", "auth"]);
      }).toThrow("EXIT_1");

      const errorCall = errorSpy.mock.calls[0]?.[0] as string;
      expect(errorCall).toContain('Input "auth" is ambiguous');
      expect(errorCall).toContain("branch:auth");
      expect(errorCall).toContain("path:auth");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      parseSpy.mockRestore();
    }
  });

  it("[P1] does not call parseReviewScope directly — avoids double parsing", () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const parseSpy = vi.spyOn(scopeResolver, 'parseReviewScope').mockImplementation(() => ({
      kind: "guidance",
      text: "test",
    } as ReturnType<typeof scopeResolver.parseReviewScope>));

    try {
      const program = createCliProgram();
      program.parse(["node", "omre", "dry-run", "focus on tests"]);

      // parseReviewScope must be called exactly once (by renderLocalDryRun only),
      // never directly by cli.ts action handler.
      expect(parseSpy).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      parseSpy.mockRestore();
    }
  });
});

describe("init CLI", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("creates config file when it does not exist", () => {
    const tmpDir = fs.mkdtempSync(".omre-init-test-");
    const tmpDirAbs = path.resolve(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    try {
      process.chdir(tmpDir);
      const program = createCliProgram();
      program.parse(["node", "omre", "init"]);

      const configFile = path.join(tmpDirAbs, ".opencode", "oh-my-review-experts.jsonc");
      expect(fs.existsSync(configFile)).toBe(true);

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("created:");
      expect(logOutput).toContain("oh-my-review-experts.jsonc");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      logSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("warns when config already exists without --force", () => {
    const tmpDir = fs.mkdtempSync(".omre-init-test-");
    const tmpDirAbs = path.resolve(tmpDir);
    const configDir = path.join(tmpDirAbs, ".opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "oh-my-review-experts.jsonc"), "{}", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    try {
      process.chdir(tmpDir);
      const program = createCliProgram();
      program.parse(["node", "omre", "init"]);

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("exists:");
      expect(logOutput).toContain("oh-my-review-experts.jsonc");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      logSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("overwrites config with --force", () => {
    const tmpDir = fs.mkdtempSync(".omre-init-test-");
    const tmpDirAbs = path.resolve(tmpDir);
    const configDir = path.join(tmpDirAbs, ".opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "oh-my-review-experts.jsonc"), "old content", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    try {
      process.chdir(tmpDir);
      const program = createCliProgram();
      program.parse(["node", "omre", "init", "--force"]);

      const configFile = path.join(configDir, "oh-my-review-experts.jsonc");
      const content = fs.readFileSync(configFile, "utf8");
      expect(content).not.toBe("old content");

      const logOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logOutput).toContain("created:");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      logSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("doctor CLI --clean-reports", () => {
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("removes stray reports and prints cleanup message when --clean-reports is set", () => {
    process.exitCode = undefined;
    const captured = captureOutput();
    const tmpDir = fs.mkdtempSync(".omre-doctor-clean-");
    const strayFile = path.join(tmpDir, "foo-report.md");
    fs.writeFileSync(strayFile, "# Stray", "utf8");

    try {
      runDoctor({
        cwd: tmpDir,
        output: captured.output,
        contractChecks: cleanContractChecks,
        cleanReports: true,
      });
      const text = stripAnsi(captured.lines.join("\n"));
      expect(text).toContain("--clean-reports applied");
      expect(fs.existsSync(strayFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("doctor CLI --strict", () => {
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("sets exitCode to 1 with strict when layout warnings exist", () => {
    process.exitCode = undefined;
    const captured = captureOutput();
    const tmpDir = fs.mkdtempSync(".omre-doctor-strict-");
    fs.writeFileSync(path.join(tmpDir, "foo-report.md"), "# Stray", "utf8");

    try {
      runDoctor({
        cwd: tmpDir,
        output: captured.output,
        contractChecks: cleanContractChecks,
        strict: true,
      });
      expect(process.exitCode).toBe(1);
      const text = stripAnsi(captured.lines.join("\n"));
      expect(text).toContain("foo-report.md");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not set exitCode with strict when no warnings exist", () => {
    process.exitCode = undefined;
    const captured = captureOutput();
    const tmpDir = fs.mkdtempSync(".omre-doctor-strict-clean-");

    try {
      runDoctor({
        cwd: tmpDir,
        output: captured.output,
        contractChecks: cleanContractChecks,
        strict: true,
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps exitCode 2 with strict when contract warnings exist", () => {
    process.exitCode = undefined;
    const captured = captureOutput();
    const tmpDir = fs.mkdtempSync(".omre-doctor-strict-contract-");
    const warningChecks: DoctorContractChecks = {
      checkPromptExampleSchemaIdentity: () => ["fake contract violation"],
      checkAgentToolWhitelist: () => [],
    };

    try {
      runDoctor({
        cwd: tmpDir,
        output: captured.output,
        contractChecks: warningChecks,
        strict: true,
      });
      expect(process.exitCode).toBe(2);
      const text = stripAnsi(captured.lines.join("\n"));
      expect(text).toContain("fake contract violation");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

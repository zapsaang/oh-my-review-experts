import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliProgram, runDoctor, type DoctorContractChecks } from "../src/cli.js";
import { ScopeResolutionError, AmbiguousScopeError } from "../src/workflow/scope-resolver.js";
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
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

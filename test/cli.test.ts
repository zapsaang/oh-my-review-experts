import { afterEach, describe, expect, it } from "vitest";
import { createCliProgram, runDoctor, type DoctorContractChecks } from "../src/cli.js";

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

import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

let tmpBefore: number;
let cwdBefore: number;

export function setup(): void {
  tmpBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("omre-test-")).length;
  cwdBefore = readdirSync(process.cwd()).filter((name) => name.startsWith("omre-test-")).length;
}

export function teardown(): void {
  const tmpAfter = readdirSync(tmpdir()).filter((name) => name.startsWith("omre-test-")).length;
  const cwdAfter = readdirSync(process.cwd()).filter((name) => name.startsWith("omre-test-")).length;

  if (tmpAfter !== tmpBefore) {
    throw new Error(
      `Temp directory leak detected in ${tmpdir()}: ` +
      `before=${tmpBefore}, after=${tmpAfter}. ` +
      `Run \`ls ${tmpdir()}/omre-test-*\` to inspect.`
    );
  }

  if (cwdAfter !== cwdBefore) {
    throw new Error(
      `Temp directory leak detected in cwd: ` +
      `before=${cwdBefore}, after=${cwdAfter}. ` +
      `Run \`ls ./omre-test-*\` to inspect.`
    );
  }
}

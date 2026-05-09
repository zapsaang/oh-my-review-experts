import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const DRY_RUN = process.argv.includes("--dry-run");
const PKG_FILE = "package.json";
const NAMES = ["@zapsaang/oh-my-review-experts", "oh-my-review-experts"];

function log(msg) {
  console.log(`[publish-dual] ${msg}`);
}

function run(cmd) {
  log(`Running: ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

async function main() {
  const raw = readFileSync(PKG_FILE, "utf-8");
  const pkg = JSON.parse(raw);
  const originalName = pkg.name;

  try {
    for (const name of NAMES) {
      log(`Publishing as: ${name}`);
      pkg.name = name;
      writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + "\n");

      const cmd = DRY_RUN
        ? `npm publish --dry-run`
        : `npm publish`;

      run(cmd);
    }

    log("✅ Both packages published successfully!");
  } catch (err) {
    console.error(`❌ Publish failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    pkg.name = originalName;
    writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + "\n");
    log(`Restored name to: ${originalName}`);
  }
}

main();

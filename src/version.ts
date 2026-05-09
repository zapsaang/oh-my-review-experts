import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgPath = path.resolve(__dirname, "../package.json")
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string }

export const VERSION = pkg.version

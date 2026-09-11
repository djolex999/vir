import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The ONE runtime read of the published version. rootDir is ./src, so
// package.json can't be imported — and every hand-counted `..` hop to reach it
// is a chance to drift (the MCP server shipped a hardcoded "0.1.1" for
// sixteen releases). This module compiles to dist/version.js, so package.json
// is exactly one level up. Any failure yields "unknown" rather than throwing:
// nothing here is worth crashing a command over.
export function readVirVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    return (
      (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string })
        .version ?? "unknown"
    );
  } catch {
    return "unknown";
  }
}

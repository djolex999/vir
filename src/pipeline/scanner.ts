import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredSession {
  path: string;
  hash: string;
  size: number;
}

export function hashFile(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

export function scanSessions(projectsDir: string): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  walk(projectsDir, out);
  return out;
}

function walk(dir: string, acc: DiscoveredSession[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (st.isFile() && name.endsWith(".jsonl")) {
      try {
        acc.push({
          path: full,
          hash: hashFile(full),
          size: st.size,
        });
      } catch {
        // unreadable file - skip
      }
    }
  }
}

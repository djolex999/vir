// Child-process entry for one usefulness arm. HOME is the arm home, so every
// production path constant resolves inside it. Read-only DB, production
// retriever, one JSON file out.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { CONFIG_PATH, STATE_PATH, loadConfig } from "../../src/config.js";
import { LOCAL_PROVIDER_DIR } from "../../src/search/localProvider.js";
import { searchWithOutcome } from "../../src/search/retriever.js";
import { StateDb } from "../../src/state/db.js";
import { sessionIdFromNote } from "./select.js";
import type { ArmRetrieval, UsefulnessArmOutput } from "./types.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`usefulness worker: missing --${name}`);
  return v;
}

async function main(): Promise<void> {
  const armId = arg("arm");
  const limit = Number.parseInt(arg("limit"), 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("usefulness worker: --limit must be ≥ 1");
  const questions = JSON.parse(readFileSync(arg("questions"), "utf8")) as Array<{ id: string; question: string }>;
  const cfg = loadConfig();
  const db = new StateDb(STATE_PATH, { readonly: true });
  const results: ArmRetrieval[] = [];
  try {
    const starts = new Map(db.listDistilled().map((r) => [r.sessionId, r.startedAt]));
    for (const q of questions) {
      const o = await searchWithOutcome(cfg, db, q.question, limit);
      results.push({
        questionId: q.id,
        method: o.method,
        degraded: o.degraded,
        hits: o.hits.map((h) => {
          const sessionId = existsSync(h.filePath) ? sessionIdFromNote(readFileSync(h.filePath, "utf8")) : null;
          return {
            filePath: h.filePath, title: h.title, content: h.content, score: h.score, method: h.method,
            sessionId, startedAt: sessionId === null ? null : (starts.get(sessionId) ?? null),
          };
        }),
      });
    }
  } finally {
    db.close();
  }
  const out: UsefulnessArmOutput = {
    armId, home: homedir(), dbPath: STATE_PATH, configPath: CONFIG_PATH, embedderDir: LOCAL_PROVIDER_DIR, results,
  };
  writeFileSync(arg("out"), JSON.stringify(out), "utf8");
}

main().catch((err: unknown) => {
  process.stderr.write(`usefulness worker failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

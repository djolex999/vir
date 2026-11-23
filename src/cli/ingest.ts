import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { ingestMeeting } from "../meetings/ingest.js";
import { resolveEmbeddingProvider } from "../search/provider.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import { withPipelineLock } from "./guards.js";

// `vir ingest --source <tool> <file>`: index a meeting note another tool wrote.
// Called by Muninn after every note (its default hand-over command), so every
// failure exits 1 with one line: Muninn queues the file and retries. A held
// pipeline lock also exits 1 (withPipelineLock), which is a retry, not a loss.

export interface IngestCliOptions {
  source: string;
}

export async function ingestCommand(file: string, opts: IngestCliOptions): Promise<void> {
  const path = resolve(file);
  const fail = (msg: string): void => {
    ui.row(ui.errorColor(ui.CROSS), ui.text(msg));
    process.exitCode = 1;
  };
  if (!existsSync(path) || !statSync(path).isFile()) return fail(`not a file: ${path}`);
  if (!path.endsWith(".md")) return fail(`not a Markdown note: ${path}`);
  const cfg = loadConfig();
  await withPipelineLock(async () => {
    const provider = await resolveEmbeddingProvider(cfg.embeddingProvider);
    const db = new StateDb();
    try {
      const outcome = await ingestMeeting(
        db,
        path,
        readFileSync(path, "utf8"),
        opts.source,
        provider,
        (m) => ui.line(ui.dim(`  ${m}`)),
      );
      if (outcome.status === "rejected") return fail(`${outcome.reason}: ${path}`);
      if (outcome.status === "unchanged") {
        ui.row(ui.success(ui.CHECK), ui.text(`already indexed: ${outcome.title}`));
        return;
      }
      ui.row(
        ui.success(ui.CHECK),
        ui.text(
          outcome.embedded
            ? `indexed meeting: ${outcome.title}`
            : `indexed meeting: ${outcome.title} (no embedding yet; the next vir run fills it)`,
        ),
      );
    } finally {
      db.close();
    }
  });
}

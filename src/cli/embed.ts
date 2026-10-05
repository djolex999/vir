import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import {
  embedNoteWithProvider,
  resolveEmbeddingProvider,
} from "../search/provider.js";
import { runEmbedSetup } from "./embedSetup.js";
import { StateDb } from "../state/db.js";
import * as ui from "../ui/display.js";
import { VaultWriter } from "../pipeline/writer.js";

export async function embedCommand(
  opts: { force?: boolean; setup?: boolean; yes?: boolean },
): Promise<void> {
  if (opts.setup) {
    await runEmbedSetup(opts.yes === true);
    return;
  }
  const cfg = loadConfig();
  ui.header("embed");
  ui.blank();
  const provider = await resolveEmbeddingProvider(cfg.embeddingProvider);
  if (!provider) {
    ui.row(ui.errorColor(ui.CROSS), ui.text("no embedding provider available"));
    ui.line(ui.dim("  vir embed --setup      # local provider, no Ollama needed (~233 MB)"));
    ui.line(ui.dim("  or: brew install ollama && ollama pull nomic-embed-text && ollama serve"));
    process.exitCode = 1;
    return;
  }
  const provenance = provider.provenance();
  const db = new StateDb();
  try {
    // Same text the writer embeds (note file minus generated sections),
    // falling back to stored content when a file is gone.
    const text = new VaultWriter(cfg, db).embeddingText;
    const rows = db.listDistilled();
    const root = join(cfg.vaultPath, cfg.outputDir);
    const embeddedRows = [
      ...db.getEmbeddings(root),
      ...db.getArticleEmbeddings(),
      ...db.getTopicEmbeddings(root, cfg.topicsDir),
      ...db.getPdfEmbeddings(),
    ];
    // Crossing a model boundary is an index invalidation, not a gap fill —
    // it needs --force AND explicit consent, with the cost stated first.
    // Without --force, mismatched rows stay excluded from vector search
    // (counted, reported) and only NULL-embedding gaps are filled.
    const mismatched = embeddedRows.filter(
      (r) => r.embeddingModel !== provider.modelName,
    ).length;
    if (mismatched > 0 && !opts.force) {
      ui.row(
        ui.warn(ui.WARN_GLYPH),
        ui.text(
          `${mismatched} note(s) are embedded under a different model than the active one (${provider.modelName})`,
        ),
      );
      ui.line(ui.dim("they are excluded from vector search until re-embedded"));
      ui.line(ui.dim("run `vir embed --force` to re-embed the whole index"));
    }
    if (mismatched > 0 && opts.force) {
      const estSecs = Math.max(1, Math.round(rows.length * 0.15));
      ui.row(
        ui.warn(ui.WARN_GLYPH),
        ui.text(
          `model boundary: re-embedding ${rows.length} note(s) under ${provider.modelName} (~${estSecs}s), replacing vectors from other models`,
        ),
      );
      if (!opts.yes) {
        const rl = createInterface({ input: stdin, output: stdout });
        const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
        rl.close();
        if (answer !== "y" && answer !== "yes") {
          ui.line(ui.dim("aborted — index unchanged"));
          return;
        }
      }
    }
    const existing = new Set(
      db
        .getEmbeddings(root)
        .filter((r) => r.embeddingModel === provider.modelName)
        .map((r) => r.sessionId),
    );
    const target = opts.force
      ? rows
      : rows.filter((r) => !existing.has(r.sessionId));

    // Topics live in their own table, so backfill them here too — a compose
    // while Ollama was down heals on a manual `vir embed`, not only the next
    // `vir run` sweep. --force re-embeds all topics; otherwise just NULL ones.
    const topicTargets: Array<{ id: string; content: string | null }> =
      opts.force
        ? db.listTopics().map((t) => ({ id: t.id, content: t.content }))
        : db.listTopicEmbeddingTargets();

    // Articles live in their own table too — back-fill them here so a clip
    // distilled while Ollama was down heals on a manual `vir embed`, not only
    // the next `vir run` sweep. --force re-embeds all embeddable articles
    // (keyed by source path); otherwise just the NULL-embedding ones.
    const articleTargets: Array<{
      path: string;
      notePath: string | null;
      content: string | null;
    }> =
      opts.force
        ? db.listArticles().map((a) => ({
            path: a.path,
            notePath: a.notePath,
            content: a.content,
          }))
        : db.listArticleEmbeddingTargets();

    // PDFs live in their own table too — same back-fill rationale as articles.
    const pdfTargets: Array<{
      path: string;
      notePath: string | null;
      content: string | null;
    }> =
      opts.force
        ? db.listPdfs().map((p) => ({
            path: p.path,
            notePath: p.notePath,
            content: p.content,
          }))
        : db.listPdfEmbeddingTargets();

    const total =
      target.length +
      topicTargets.length +
      articleTargets.length +
      pdfTargets.length;
    if (total === 0) {
      ui.row(ui.success(ui.CHECK), ui.text("all notes already embedded"));
      return;
    }

    const sp = ui.spinner(`embedding notes (0/${total})`).start();
    let embedded = 0;
    let skipped = 0;
    let errors = 0;
    for (let i = 0; i < target.length; i += 1) {
      const r = target[i];
      if (!r) continue;
      if (r.content.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const vec = await embedNoteWithProvider(
        provider,
        text.session(r.sessionId) ?? r.content,
      );
      if (!vec) {
        errors += 1;
        continue;
      }
      db.storeEmbedding(r.sessionId, vec, provenance);
      embedded += 1;
      sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
    }
    for (const t of topicTargets) {
      if (!t.content || t.content.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const vec = await embedNoteWithProvider(
        provider,
        text.topic(t.id) ?? t.content,
      );
      if (!vec) {
        errors += 1;
        continue;
      }
      db.storeTopicEmbedding(t.id, vec, provenance);
      embedded += 1;
      sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
    }
    for (const a of articleTargets) {
      if (!a.content || a.content.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const vec = await embedNoteWithProvider(
        provider,
        (a.notePath ? text.file(a.notePath) : null) ?? a.content,
      );
      if (!vec) {
        errors += 1;
        continue;
      }
      db.storeArticleEmbedding(a.path, vec, provenance);
      embedded += 1;
      sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
    }
    for (const p of pdfTargets) {
      if (!p.content || p.content.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const vec = await embedNoteWithProvider(
        provider,
        (p.notePath ? text.file(p.notePath) : null) ?? p.content,
      );
      if (!vec) {
        errors += 1;
        continue;
      }
      db.storePdfEmbedding(p.path, vec, provenance);
      embedded += 1;
      sp.text = ui.dim(`embedding notes (${embedded}/${total})`);
    }
    sp.succeed(ui.text(`embedded ${embedded} notes`));
    ui.blank();
    ui.divider();
    ui.summary({
      embedded: { value: embedded, color: ui.success },
      skipped: { value: skipped, color: ui.muted },
      errors: {
        value: errors,
        color: errors > 0 ? ui.errorColor : ui.dim,
      },
    });
    ui.divider();
  } finally {
    db.close();
  }

}

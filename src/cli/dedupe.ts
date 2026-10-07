import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../config.js";
import { detectDuplicates } from "../dedupe/detector.js";
import { mergeNotes } from "../dedupe/merger.js";
import { sessionSuffix } from "../pipeline/slug.js";
import { StateDb } from "../state/db.js";
import { confirmPaidStep, withPipelineLock } from "./guards.js";

export async function dedupeCommand(
  opts: { yes?: boolean },
): Promise<void> {
  const cfg = loadConfig();
  const proceed = await confirmPaidStep(
    `dedupe checks up to 30 candidate pairs with ${cfg.models.classify} (one paid call each, plus one per merge you accept)`,
    { yes: opts.yes },
  );
  if (!proceed) return;
  await withPipelineLock(async () => {
    const db = new StateDb();
    try {
      console.log("scanning for duplicate candidates...");
      const result = await detectDuplicates(cfg, db);
      console.log(
        `${result.checked} candidate pairs checked, ${result.duplicates.length} flagged as duplicates`,
      );
      if (result.duplicates.length === 0) {
        return;
      }

      const rl = createInterface({ input: stdin, output: stdout });
      let merged = 0;
      let skipped = 0;
      for (const dup of result.duplicates) {
        console.log("\nDuplicate found:");
        console.log(
          `A: ${noteRefOf(dup.a)} (conf: ${dup.a.confidence.toFixed(2)}, ${dup.a.startedAt?.slice(0, 10) ?? "?"})`,
        );
        console.log(`   "${preview(dup.a.content)}"`);
        console.log(
          `B: ${noteRefOf(dup.b)} (conf: ${dup.b.confidence.toFixed(2)}, ${dup.b.startedAt?.slice(0, 10) ?? "?"})`,
        );
        console.log(`   "${preview(dup.b.content)}"`);
        console.log(`Reason: ${dup.reason}`);
        const suggestion =
          dup.keepWhich === "merge"
            ? "merge both"
            : `keep ${dup.keepWhich}`;
        console.log(`Suggested: ${suggestion}`);

        const ans = (
          await rl.question(
            "[k]eep suggestion / [s]wap / [m]erge / [x] skip: ",
          )
        )
          .trim()
          .toLowerCase();

        let action: "A" | "B" | "merge" | null = null;
        if (ans === "k" || ans === "") {
          action = dup.keepWhich;
        } else if (ans === "s") {
          action =
            dup.keepWhich === "A"
              ? "B"
              : dup.keepWhich === "B"
                ? "A"
                : "merge";
        } else if (ans === "m") {
          action = "merge";
        } else if (ans === "x") {
          skipped += 1;
          continue;
        } else {
          console.log(chalk.yellow("unknown input — skipping"));
          skipped += 1;
          continue;
        }

        try {
          const outcome = await mergeNotes(cfg, db, dup.a, dup.b, action);
          merged += 1;
          console.log(
            chalk.green(
              `merged (${outcome.action}): winner=${outcome.winnerPath} archived=${outcome.archivedPath}`,
            ),
          );
        } catch (err) {
          console.error(
            chalk.red(`merge failed: ${(err as Error).message}`),
          );
        }
      }
      rl.close();
      console.log(
        `\n${result.duplicates.length} pairs reviewed, ${merged} merged, ${skipped} skipped.`,
      );
    } finally {
      db.close();
    }
  });

}

function noteRefOf(r: {
  category: string;
  topic: string;
  sessionId: string;
}): string {
  const dir = `${r.category}s`;
  const slug = r.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${dir}/${slug}-${sessionSuffix(r.sessionId)}`;
}

function preview(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80);
}

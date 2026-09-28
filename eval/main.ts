// `npm run eval -- <command>`. Not a vir CLI command: nothing here ships
// (package.json `files` whitelists dist/ only; this tree compiles to eval/dist).
import { ARMS, armById } from "./arms.js";
import { prepareHomes } from "./prepareHomes.js";
import { buildQuerySet } from "./queries/build.js";
import { buildAndWritePool, labelPool } from "./labels/run.js";
import { runSpotcheck } from "./labels/spotcheck.js";
import { showLabels } from "./labels/show.js";
import { runBaseline } from "./run.js";
import { mineQuestions } from "./usefulness/mineRun.js";
import { showLatestRun, usefulnessRun } from "./usefulness/run.js";

const DEFAULT_SEED = 20260911;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const USAGE = `usage: npm run eval -- <command> [--seed N] [--dry-run]

  queries     build ~/.vir/eval/queries.json (real / identifier / conceptual / garbage)
  homes       prepare one isolated HOME per arm (config + db copy; bge install + re-embed)
              [--arm <id>] [--refresh]
  pool        run every arm at top-${20} and write the pooled candidate lists
  label       judge every pooled pair with claude -p (--dry-run reports calls + tokens)
  spotcheck   blind-grade 20 pairs yourself and report agreement with the model
  show        print labeled queries with grades and arm ranks [--per-class N]
  run         run every arm at top-8 against the labels; write ~/.vir/eval/runs/<ts>.json
  arms        list arms
  usefulness mine   mine questions + facts from recent transcripts (--dry-run)
  usefulness run    full vs ablated vs none → PASS/FAIL/NO VERDICT for the audit's rejects (--seed, --dry-run)
  usefulness show   summary of the latest usefulness run`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const seed = Number.parseInt(opt("seed") ?? String(DEFAULT_SEED), 10);
  const dryRun = flag("dry-run");
  switch (cmd) {
    case "queries":
      await buildQuerySet({ seed, dryRun });
      return;
    case "homes": {
      const armId = opt("arm");
      await prepareHomes({ arms: armId ? [armById(armId)] : ARMS, refresh: flag("refresh") });
      return;
    }
    case "pool":
      await buildAndWritePool();
      return;
    case "label":
      await labelPool({ seed, dryRun });
      return;
    case "spotcheck":
      await runSpotcheck({ seed });
      return;
    case "show": {
      const per = opt("per-class");
      process.stdout.write(showLabels({ perClass: per ? Number.parseInt(per, 10) : null, seed }));
      return;
    }
    case "run":
      await runBaseline({ seed });
      return;
    case "arms":
      for (const a of ARMS) process.stdout.write(`${a.id.padEnd(10)} ${a.label}\n`);
      return;
    case "usefulness": {
      const sub = process.argv[3];
      switch (sub) {
        case "mine":
          await mineQuestions({ dryRun });
          return;
        case "run":
          await usefulnessRun({ seed: opt("seed") ? seed : 20260926, dryRun });
          return;
        case "show":
          process.stdout.write(`${showLatestRun()}\n`);
          return;
        default:
          process.stderr.write(`${USAGE}\n`);
          process.exit(2);
      }
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`eval failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

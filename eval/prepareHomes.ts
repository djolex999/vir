import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, STATE_PATH } from "../src/config.js";
import { ARMS, type ArmSpec } from "./arms.js";
import { buildArmConfig } from "./homes.js";
import { CLI_JS } from "./repo.js";
import { armHome } from "./runArm.js";

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

// Consistent copy of the live DB through SQLite's backup API from a read-only
// connection — never a file copy of a WAL-mode database mid-write.
export async function copyDb(dest: string): Promise<void> {
  const src = new Database(STATE_PATH, { readonly: true, fileMustExist: true });
  try {
    await src.backup(dest);
  } finally {
    src.close();
  }
}

function runCli(home: string, args: string[]): void {
  const res = spawnSync(process.execPath, [CLI_JS, ...args], {
    env: { ...process.env, HOME: home },
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(`vir ${args.join(" ")} under HOME=${home} exited ${res.status}`);
  }
}

export interface PrepareOpts {
  arms?: readonly ArmSpec[];
  // Re-copy config + DB even if the home exists. The bge install and re-embed
  // are always skipped when already done (detected on disk / in the DB).
  refresh?: boolean;
}

export async function prepareHomes(opts: PrepareOpts = {}): Promise<void> {
  if (!existsSync(CLI_JS)) throw new Error(`${CLI_JS} missing — run \`npm run build\` first`);
  const rawCfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;

  for (const arm of opts.arms ?? ARMS) {
    const home = armHome(arm);
    const virDir = join(home, ".vir");
    const cfgPath = join(virDir, "config.json");
    const dbPath = join(virDir, "vir.db");
    mkdirSync(virDir, { recursive: true });

    if (opts.refresh || !existsSync(cfgPath)) {
      writeFileSync(cfgPath, JSON.stringify(buildArmConfig(rawCfg, arm), null, 2));
      chmodSync(cfgPath, 0o600);
      log(`[${arm.id}] config written → ${cfgPath}`);
    }
    if (opts.refresh || !existsSync(dbPath)) {
      await copyDb(dbPath);
      log(`[${arm.id}] db copied → ${dbPath}`);
    }

    if (arm.provider === "local") {
      // Both steps are the production CLI under the arm's HOME: fastembed
      // installs into <home>/.vir/embedder, vectors land in <home>/.vir/vir.db.
      const installed = existsSync(join(virDir, "embedder", "node_modules", "fastembed"));
      if (!installed) {
        log(`[${arm.id}] installing fastembed into ${join(virDir, "embedder")} (~233 MB + 128 MB model)`);
        runCli(home, ["embed", "--setup", "--yes"]);
      }
      const db = new Database(dbPath, { readonly: true });
      let pending = 0;
      try {
        const row = db
          .prepare(
            // Pruned rows keep their old vectors (production `vir embed`
            // walks live rows only) and are gated out of every read path.
            "SELECT COUNT(*) AS n FROM sessions WHERE embedding IS NOT NULL AND embedding_model != 'bge-small-en-v1.5' AND pruned_at IS NULL",
          )
          .get() as { n: number };
        pending = row.n;
      } finally {
        db.close();
      }
      if (pending > 0) {
        log(`[${arm.id}] re-embedding ${pending} session rows under bge (production \`vir embed --force\`)`);
        runCli(home, ["embed", "--force", "--yes"]);
      } else {
        log(`[${arm.id}] bge vectors already present`);
      }
    }
  }
}

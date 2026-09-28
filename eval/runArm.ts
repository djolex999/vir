import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ArmSpec } from "./arms.js";
import { EVAL_HOMES_DIR, EVAL_QUERIES_PATH } from "./paths.js";
import { ARM_WORKER_JS } from "./repo.js";
import type { ArmRunOutput } from "./types.js";

export function armHome(arm: ArmSpec): string {
  return join(EVAL_HOMES_DIR, arm.id);
}

// Spawns the worker with HOME = the arm home and refuses its output unless the
// child's own path constants all resolved inside that home — the isolation
// claim is checked on every run, not assumed from the design.
export async function runArm(
  arm: ArmSpec,
  limit: number,
  queriesPath: string = EVAL_QUERIES_PATH,
): Promise<ArmRunOutput> {
  const home = armHome(arm);
  if (!existsSync(join(home, ".vir", "config.json"))) {
    throw new Error(`arm home not prepared: ${home} (run \`npm run eval -- homes\`)`);
  }
  if (!existsSync(ARM_WORKER_JS)) {
    throw new Error(`worker not built: ${ARM_WORKER_JS} (run \`npm run eval:build\`)`);
  }
  const tmpDir = join(home, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const outPath = join(tmpDir, `arm-${Date.now()}.json`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [ARM_WORKER_JS, "--arm", arm.id, "--queries", queriesPath, "--limit", String(limit), "--out", outPath],
      { env: { ...process.env, HOME: home }, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`arm ${arm.id} worker exited ${code}`)),
    );
  });

  const out = JSON.parse(readFileSync(outPath, "utf8")) as ArmRunOutput;
  unlinkSync(outPath);
  assertArmIsolation(out, home, arm.id);
  return out;
}

// Shared by every arm worker: the isolation claim is checked on every run.
export function assertArmIsolation(
  out: { home: string; dbPath: string; configPath: string; embedderDir: string },
  home: string,
  armId: string,
): void {
  for (const [k, v] of [
    ["home", out.home],
    ["dbPath", out.dbPath],
    ["configPath", out.configPath],
    ["embedderDir", out.embedderDir],
  ] as const) {
    if (!v.startsWith(home + "/") && v !== home) {
      throw new Error(`isolation violated: arm ${armId} resolved ${k}=${v}, expected under ${home}`);
    }
  }
}

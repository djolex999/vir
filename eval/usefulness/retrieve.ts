import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USEFULNESS_WORKER_JS } from "../repo.js";
import { armHome, assertArmIsolation } from "../runArm.js";
import { USEFULNESS_ARM_SPECS } from "./homes.js";
import { FETCH_K } from "./select.js";
import type { ArmRetrieval, MinedQuestion, RetrievalArm, UsefulnessArmOutput } from "./types.js";

export async function runUsefulnessArm(arm: RetrievalArm, questions: readonly MinedQuestion[]): Promise<ArmRetrieval[]> {
  const spec = USEFULNESS_ARM_SPECS[arm];
  const home = armHome(spec);
  if (!existsSync(join(home, ".vir", "config.json"))) throw new Error(`arm home not prepared: ${home}`);
  if (!existsSync(USEFULNESS_WORKER_JS)) throw new Error(`worker not built: ${USEFULNESS_WORKER_JS} (run \`npm run eval:build\`)`);
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const inPath = join(tmp, `uq-${stamp}.json`);
  const outPath = join(tmp, `uout-${stamp}.json`);
  writeFileSync(inPath, JSON.stringify(questions.map((q) => ({ id: q.id, question: q.question }))));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [USEFULNESS_WORKER_JS, "--arm", spec.id, "--questions", inPath, "--limit", String(FETCH_K), "--out", outPath],
        { env: { ...process.env, HOME: home }, stdio: ["ignore", "inherit", "inherit"] },
      );
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`usefulness arm ${spec.id} worker exited ${code}`))));
    });
    const out = JSON.parse(readFileSync(outPath, "utf8")) as UsefulnessArmOutput;
    assertArmIsolation(out, home, spec.id);
    return out.results;
  } finally {
    for (const p of [inPath, outPath]) if (existsSync(p)) unlinkSync(p);
  }
}

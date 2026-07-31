import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  LOCAL_PROVIDER_DIR,
  LocalProvider,
  buildSetupPlan,
  isLocalProviderInstalled,
} from "../search/localProvider.js";
import * as ui from "../ui/display.js";

// `vir embed --setup`: the one-command activation path for semantic search
// without Ollama. States the disk cost and waits for consent BEFORE touching
// disk or network; --yes skips the prompt, never the cost statement.
export async function runEmbedSetup(yes: boolean): Promise<void> {
  ui.header("embed --setup");
  ui.blank();
  const plan = buildSetupPlan(isLocalProviderInstalled(), false);
  for (const l of plan.lines) ui.line(ui.text(l));
  ui.blank();

  if (!yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      ui.line(ui.dim("aborted — nothing was installed"));
      return;
    }
  }

  if (plan.needsInstall) {
    mkdirSync(LOCAL_PROVIDER_DIR, { recursive: true });
    const pkgPath = join(LOCAL_PROVIDER_DIR, "package.json");
    if (!existsSync(pkgPath)) {
      writeFileSync(
        pkgPath,
        `${JSON.stringify({ name: "vir-embedder", private: true }, null, 2)}\n`,
      );
    }
    ui.line(ui.dim("installing fastembed (npm output follows)…"));
    const res = spawnSync(
      "npm",
      [
        "install",
        "fastembed@^2",
        "--prefix",
        LOCAL_PROVIDER_DIR,
        "--no-fund",
        "--no-audit",
      ],
      { stdio: "inherit" },
    );
    if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
      ui.row(ui.errorColor(ui.CROSS), ui.text("npm not found on PATH"));
      ui.line(ui.dim("install Node.js/npm, then re-run vir embed --setup"));
      process.exitCode = 1;
      return;
    }
    if (res.status !== 0) {
      ui.row(ui.errorColor(ui.CROSS), ui.text("npm install failed — see output above"));
      process.exitCode = 1;
      return;
    }
  }

  ui.line(ui.dim("downloading the model and warming up (first embed)…"));
  const t0 = Date.now();
  const provider = new LocalProvider();
  await provider.embedDoc("vir local embedding setup probe");
  const secs = Math.round((Date.now() - t0) / 1000);
  ui.row(
    ui.success(ui.CHECK),
    ui.text(`local provider ready: ${provider.modelName}, ${provider.dimensions}d (${secs}s)`),
  );
  ui.line(
    ui.dim("vir uses it automatically when Ollama is not running; `vir embed` backfills notes."),
  );
}

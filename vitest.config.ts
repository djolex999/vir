import { defineConfig } from "vitest/config";

// The site has its own vitest (site/package.json) and worktrees under .claude/
// carry full copies of src — neither belongs in the CLI's suite.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "site/**"],
  },
});

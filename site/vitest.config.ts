import { defineConfig } from "vitest/config";

// Without this, vitest walks up and finds the repo root's config — which
// resolves fine locally (the root has node_modules) and fails in CI, where
// only site/ is installed. The site's tests are pure helpers; they need no
// Astro plugin.
export default defineConfig({
  test: {
    root: ".",
    include: ["src/**/*.test.ts"],
  },
});

import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://vir.sh",
  output: "static",
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});

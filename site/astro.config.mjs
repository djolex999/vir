import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://virwiki.dev",
  output: "static",
  integrations: [
    starlight({
      title: "vir docs",
      description: "An LLM Wiki for Claude Code, in your Obsidian vault.",
      logo: { src: "./src/assets/logo.svg", alt: "vir" },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/djolex999/vir" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/@djolex999/vir-cli" },
      ],
      customCss: [
        "@fontsource/instrument-serif",
        "@fontsource-variable/inter",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/starlight.css",
      ],
      editLink: { baseUrl: "https://github.com/djolex999/vir/edit/main/site/" },
      lastUpdated: true,
      sidebar: [
        { label: "Getting started", slug: "docs/getting-started" },
        { label: "How it works", slug: "docs/how-it-works" },
        { label: "Inputs", slug: "docs/inputs" },
        { label: "Retrieval and MCP", slug: "docs/retrieval" },
        { label: "Keeping it current", slug: "docs/keeping-it-current" },
        { label: "Providers and cost", slug: "docs/providers-and-cost" },
        { label: "Configuration", slug: "docs/configuration" },
        { label: "Commands", slug: "docs/commands" },
        { label: "Obsidian plugin", slug: "docs/obsidian-plugin" },
        { label: "Troubleshooting", slug: "docs/troubleshooting" },
        { label: "Privacy", slug: "docs/privacy" },
        { label: "Changelog", slug: "docs/changelog" },
      ],
      components: {},
      disable404Route: false,
    }),
    preact(),
  ],
  vite: { plugins: [tailwindcss()] },
});

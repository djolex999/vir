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
      description: "Karpathy's LLM Wiki, built from your Claude Code sessions. Plain markdown you own.",
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
      head: [
        {
          tag: "link",
          attrs: {
            rel: "alternate",
            type: "application/rss+xml",
            title: "vir releases",
            href: "/changelog.xml",
          },
        },
        { tag: "script", attrs: { src: "/_vercel/insights/script.js", defer: true } },
      ],
      editLink: { baseUrl: "https://github.com/djolex999/vir/edit/main/site/" },
      lastUpdated: true,
      sidebar: [
        { label: "Overview", slug: "docs" },
        { label: "Getting started", slug: "docs/getting-started" },
        { label: "How it works", slug: "docs/how-it-works" },
        { label: "Inputs", slug: "docs/inputs" },
        { label: "Retrieval and MCP", slug: "docs/retrieval" },
        { label: "Keeping it current", slug: "docs/keeping-it-current" },
        { label: "Recurring rules", slug: "docs/recurring-rules" },
        { label: "Any agent", slug: "docs/any-agent" },
        { label: "Codex", slug: "docs/codex" },
        { label: "Providers and cost", slug: "docs/providers-and-cost" },
        { label: "Configuration", slug: "docs/configuration" },
        { label: "Commands", slug: "docs/commands" },
        { label: "Obsidian plugin", slug: "docs/obsidian-plugin" },
        { label: "Troubleshooting", slug: "docs/troubleshooting" },
        { label: "Privacy", slug: "docs/privacy" },
        { label: "Changelog", slug: "docs/changelog" },
        {
          label: "The vault vir wrote",
          items: [
            { label: "Overview", slug: "vault" },
            { label: "Patterns", collapsed: true, items: [{ autogenerate: { directory: "vault/patterns" } }] },
            { label: "Decisions", collapsed: true, items: [{ autogenerate: { directory: "vault/decisions" } }] },
            { label: "Gotchas", collapsed: true, items: [{ autogenerate: { directory: "vault/gotchas" } }] },
          ],
        },
      ],
      components: {},
      disable404Route: true,
    }),
    preact(),
  ],
  vite: { plugins: [tailwindcss()] },
});

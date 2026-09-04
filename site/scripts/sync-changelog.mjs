// Renders the repo CHANGELOG.md as a docs page. Runs before every build so
// the docs never drift from the file releases are cut from.
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8").replace(/^# Changelog\s*\n/, "");
const out = `---
title: Changelog
description: Every vir release, newest first. Mirrors CHANGELOG.md in the repo.
---

${src}`;
writeFileSync(new URL("../src/content/docs/docs/changelog.md", import.meta.url), out);
console.log("changelog.md synced");

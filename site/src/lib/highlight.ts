function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Wraps the parts of a vir note that the anatomy callouts point at. Input is
// our own constant strings, but it is escaped anyway so the output is inert.
export function highlightNote(md: string): string {
  const lines = escapeHtml(md).split("\n");
  const out: string[] = [];
  let inFrontmatter = false;
  let fencesSeen = 0;

  for (const raw of lines) {
    let line = raw;
    if (line === "---" && fencesSeen < 2) {
      fencesSeen += 1;
      inFrontmatter = fencesSeen === 1;
      out.push(
        fencesSeen === 1
          ? '<span class="fm-block"><span class="fence">---</span>'
          : '<span class="fence">---</span></span>',
      );
      continue;
    }
    if (inFrontmatter) {
      line = line.replace(/^(\s*)([a-z_]+)(:)/, '$1<span class="fm-key">$2</span>$3');
    } else {
      if (/^#{1,6} /.test(line)) line = `<span class="heading">${line}</span>`;
      line = line.replace(/\[\[[^\]]+\]\]/g, (m) => `<span class="wikilink">${m}</span>`);
    }
    out.push(line);
  }
  return out.join("\n");
}

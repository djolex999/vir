import { join } from "node:path";

// vir writes plain markdown; an Obsidian vault is one valid home for it, not a
// requirement. Prefer the conventional vault when it exists, else ~/notes
// (notes then land in ~/notes/vir/ via the default outputDir).
export function defaultNotesDir(
  home: string,
  exists: (p: string) => boolean,
): string {
  const vault = join(home, "Documents", "Obsidian", "MyVault");
  return exists(vault) ? vault : join(home, "notes");
}

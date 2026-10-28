import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import GithubSlugger from "github-slugger";

const DOCS_DIR = path.join(process.cwd(), "docs");

// Static content: cached so pages using it prerender at build time.
export async function readDoc(file: "api.md" | "openapi.yaml") {
  "use cache";
  return readFile(path.join(DOCS_DIR, file), "utf8");
}

export type TocItem = { id: string; title: string; depth: 2 | 3 };

/** h2/h3 headings (outside code fences), slugged exactly like rehype-slug. */
export function tableOfContents(markdown: string): TocItem[] {
  const slugger = new GithubSlugger();
  const items: TocItem[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    // Slug every heading level so duplicate counters stay in sync with rehype-slug.
    const title = m[2].replace(/`/g, "").trim();
    const id = slugger.slug(title);
    const depth = m[1].length;
    if (depth === 2 || depth === 3) items.push({ id, title, depth });
  }
  return items;
}

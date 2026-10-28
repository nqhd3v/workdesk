import type { Metadata } from "next";
import Link from "next/link";
import { DesktopIcon, FileCodeIcon } from "@phosphor-icons/react/dist/ssr";
import { MarkdownDoc } from "@/components/docs/markdown";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { readDoc, tableOfContents } from "@/lib/docs";

export const metadata: Metadata = {
  title: "API docs · Workdesk",
  description: "How to push data into Workdesk: endpoints, payloads, status codes.",
};

// Public page (see PUBLIC_PATHS in proxy.ts). Rendered at build time from docs/api.md.
export default async function DocsPage() {
  const source = await readDoc("api.md");
  const toc = tableOfContents(source).filter((t) => t.depth === 2);

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-3 px-6">
          <div className="flex size-7 items-center justify-center bg-primary text-primary-foreground">
            <DesktopIcon className="size-4" />
          </div>
          <span className="font-bold">Workdesk</span>
          <span className="text-muted-foreground">/ API docs</span>
          <div className="ml-auto flex items-center gap-2">
            <a href="/docs/openapi.yaml" className={buttonVariants({ variant: "outline", size: "sm" })}>
              <FileCodeIcon data-icon="inline-start" />
              openapi.yaml
            </a>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl gap-12 px-6 py-10">
        <article className="min-w-0 flex-1">
          <MarkdownDoc source={source} />
        </article>
        <nav aria-label="On this page" className="hidden w-52 shrink-0 lg:block">
          <div className="sticky top-20 flex flex-col gap-2 text-xs">
            <span className="font-semibold">On this page</span>
            {toc.map((item) => (
              <Link key={item.id} href={`#${item.id}`} className="text-muted-foreground hover:text-foreground">
                {item.title}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}

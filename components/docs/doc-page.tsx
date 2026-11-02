import Image from "next/image";
import Link from "next/link";
import { MarkdownDoc } from "@/components/docs/markdown";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { tableOfContents } from "@/lib/docs";

const DOCS = [
  { href: "/docs", label: "API" },
  { href: "/docs/firmware", label: "Firmware" },
] as const;

// Shared shell of the public docs pages: markdown on the left, its headings on the right.
export function DocPage({ source, active, action }: { source: string; active: (typeof DOCS)[number]["href"]; action?: React.ReactNode }) {
  const toc = tableOfContents(source).filter((t) => t.depth === 2);

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-3 px-6">
          <Image src="/icon.svg" alt="" width={28} height={28} unoptimized className="size-7" />
          <span className="font-bold">Workdesk</span>
          <nav aria-label="Docs" className="flex">
            {DOCS.map(({ href, label }) => (
              <Link key={href} href={href} aria-current={href === active ? "page" : undefined} className={buttonVariants({ variant: href === active ? "secondary" : "ghost", size: "sm" })}>
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {action}
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

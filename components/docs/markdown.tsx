import Markdown, { type Components } from "react-markdown";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// react-markdown passes its AST `node` to every component; keep it off the DOM.
function strip<P extends { node?: unknown }>(props: P): Omit<P, "node"> {
  const { node, ...rest } = props;
  void node;
  return rest;
}

// Map markdown elements onto the app's own styles/components.
const components: Components = {
  h1: (props) => <h1 className="text-2xl font-bold" {...strip(props)} />,
  h2: (props) => <h2 className="mt-12 scroll-mt-20 border-b pb-2 text-lg font-bold" {...strip(props)} />,
  h3: (props) => <h3 className="mt-8 scroll-mt-20 text-base font-semibold" {...strip(props)} />,
  p: (props) => <p className="mt-4 text-sm/relaxed" {...strip(props)} />,
  strong: (props) => <strong className="font-semibold" {...strip(props)} />,
  a: ({ href, ...props }) => {
    // Repo-relative links in api.md point at files we serve under /docs.
    const target = href === "./openapi.yaml" ? "/docs/openapi.yaml" : href;
    return <a href={target} className="underline underline-offset-4 hover:text-muted-foreground" {...strip(props)} />;
  },
  ul: (props) => <ul className="mt-4 ml-5 list-disc space-y-1 text-sm/relaxed" {...strip(props)} />,
  ol: (props) => <ol className="mt-4 ml-5 list-decimal space-y-1 text-sm/relaxed" {...strip(props)} />,
  hr: () => <hr className="my-10" />,
  blockquote: (props) => (
    <blockquote className="mt-4 border-l-2 pl-4 text-sm text-muted-foreground" {...strip(props)} />
  ),
  pre: ({ className, ...props }) => (
    <pre className={cn("mt-4 overflow-x-auto border bg-muted/50 p-4 text-xs/relaxed", className)} {...strip(props)} />
  ),
  table: (props) => (
    <div className="mt-4 border">
      <Table {...strip(props)} />
    </div>
  ),
  thead: (props) => <TableHeader {...strip(props)} />,
  tbody: (props) => <TableBody {...strip(props)} />,
  tr: (props) => <TableRow {...strip(props)} />,
  th: (props) => <TableHead className="bg-muted/50" {...strip(props)} />,
  // Docs cells hold prose, so let them wrap (shadcn cells default to nowrap).
  td: (props) => <TableCell className="align-top whitespace-normal [&_code]:whitespace-nowrap" {...strip(props)} />,
};

export function MarkdownDoc({ source }: { source: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components}>
      {source}
    </Markdown>
  );
}

import type { Metadata } from "next";
import { FileCodeIcon } from "@phosphor-icons/react/dist/ssr";
import { DocPage } from "@/components/docs/doc-page";
import { buttonVariants } from "@/components/ui/button";
import { readDoc } from "@/lib/docs";

export const metadata: Metadata = {
  title: "API docs · Workdesk",
  description: "How to push data into Workdesk: endpoints, payloads, status codes.",
};

// Public page (see PUBLIC_PATHS in proxy.ts). Rendered at build time from docs/api.md.
export default async function DocsPage() {
  return (
    <DocPage
      source={await readDoc("api.md")}
      active="/docs"
      action={
        <a href="/docs/openapi.yaml" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <FileCodeIcon data-icon="inline-start" />
          openapi.yaml
        </a>
      }
    />
  );
}

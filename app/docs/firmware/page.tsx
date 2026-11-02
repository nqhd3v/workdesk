import type { Metadata } from "next";
import { DocPage } from "@/components/docs/doc-page";
import { readDoc } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Firmware docs · Workdesk",
  description: "How to wire, build, set up and update the Workdesk desk module.",
};

// Public page (see PUBLIC_PATHS in proxy.ts). Rendered at build time from docs/firmware.md.
export default async function FirmwareDocsPage() {
  return <DocPage source={await readDoc("firmware.md")} active="/docs/firmware" />;
}

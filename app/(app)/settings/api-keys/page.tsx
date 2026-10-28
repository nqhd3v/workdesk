import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { BookOpenTextIcon, WarningIcon } from "@phosphor-icons/react/dist/ssr";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { listApiKeys, type ApiKeyRow } from "@/lib/api/keys";
import { TIMEZONE } from "@/lib/api/time";
import { CreateKeyDialog } from "./create-key-dialog";
import { KeysTable, type KeyListItem } from "./keys-table";

export const metadata: Metadata = { title: "API keys · Workdesk" };

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// Format on the server so client hydration doesn't depend on the browser's timezone or clock.
function toListItems(rows: ApiKeyRow[]): KeyListItem[] {
  const now = Date.now();
  return rows.map((k) => {
    const expiresMs = new Date(k.expires_at).getTime();
    const days = Math.round((expiresMs - now) / 86_400_000);
    return {
      id: k.id,
      name: k.name,
      scope: k.scope,
      prefix: k.key_prefix,
      deviceId: k.device_id,
      created: dateFormat.format(new Date(k.created_at)),
      expires: dateFormat.format(new Date(expiresMs)),
      expiresIn: relative.format(days, "day"),
      status: k.revoked_at ? "revoked" : expiresMs <= now ? "expired" : days <= 7 ? "expiring" : "active",
      lastUsed: k.last_used_at ? dateFormat.format(new Date(k.last_used_at)) : null,
    };
  });
}

// Access is gated in proxy.ts (owner session required).
// Data is loaded before anything renders; loading.tsx shows meanwhile.
export default async function ApiKeysPage() {
  await connection();
  const { data, error } = await listApiKeys();
  if (error) console.error("[api-keys] list", error);

  const items = data ? toListItems(data) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Keys for external senders. Pass one in the <code>x-workdesk-key</code> header.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/docs" className={buttonVariants({ variant: "outline" })}>
            <BookOpenTextIcon data-icon="inline-start" />
            API docs
          </Link>
          <CreateKeyDialog />
        </div>
      </div>
      {items ? <KeysTable data={items} /> : <LoadError missingTable={error?.code === "PGRST205"} message={error?.message} />}
    </div>
  );
}

function LoadError({ missingTable, message }: { missingTable: boolean; message?: string }) {
  return (
    <Alert variant="destructive">
      <WarningIcon />
      <AlertTitle>{missingTable ? "Database not set up" : "Could not load API keys"}</AlertTitle>
      <AlertDescription>
        {missingTable ? (
          <>
            Apply <code>supabase/migrations/20261029000000_ingest_api.sql</code> to your Supabase project, then reload.
          </>
        ) : (
          message
        )}
      </AlertDescription>
    </Alert>
  );
}

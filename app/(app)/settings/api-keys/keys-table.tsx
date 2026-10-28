"use client";

import { useTransition } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { KeyIcon } from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SCOPE_INFO, type ApiScope } from "@/lib/api/scopes";
import { revokeApiKey } from "./actions";

export type KeyListItem = {
  id: string;
  name: string;
  scope: ApiScope;
  prefix: string;
  deviceId: string | null;
  created: string;
  expires: string;
  expiresIn: string;
  status: "active" | "expiring" | "expired" | "revoked";
  lastUsed: string | null;
};

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, KeyListItem>();
const columns = helper.columns([
  helper.accessor("name", {
    header: "Name",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium">{row.original.name}</span>
        {row.original.deviceId && (
          <span className="text-muted-foreground">device: {row.original.deviceId}</span>
        )}
      </div>
    ),
  }),
  helper.accessor("scope", {
    header: "API",
    cell: ({ getValue }) => <Badge variant="outline">{SCOPE_INFO[getValue()].label}</Badge>,
  }),
  helper.accessor("prefix", {
    header: "Key",
    cell: ({ getValue }) => <code className="text-muted-foreground">{getValue()}…</code>,
  }),
  helper.accessor("created", { header: "Created" }),
  helper.accessor("expires", {
    header: "Expires",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span>{row.original.expires}</span>
        <span className={row.original.status === "expiring" ? "text-destructive" : "text-muted-foreground"}>
          {row.original.status === "expired" ? "expired" : row.original.expiresIn}
        </span>
      </div>
    ),
  }),
  helper.accessor("lastUsed", {
    header: "Last used",
    cell: ({ getValue }) => getValue() ?? <span className="text-muted-foreground">Never</span>,
  }),
  helper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) =>
      row.original.status === "revoked" ? (
        <Badge variant="destructive">Revoked</Badge>
      ) : row.original.status === "expired" ? (
        <Badge variant="secondary">Expired</Badge>
      ) : (
        <RevokeButton id={row.original.id} name={row.original.name} />
      ),
  }),
]);

export function KeysTable({ data }: { data: KeyListItem[] }) {
  const table = useTable({ features, columns, data });

  if (data.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <KeyIcon />
          </EmptyMedia>
          <EmptyTitle>No API keys yet</EmptyTitle>
          <EmptyDescription>Each sender pushing data into Workdesk needs its own key.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} className={row.original.status === "revoked" || row.original.status === "expired" ? "opacity-50" : undefined}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className={cell.column.id === "actions" ? "text-right" : undefined}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RevokeButton({ id, name }: { id: string; name: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>
        {pending ? "Revoking…" : "Revoke"}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke &ldquo;{name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            Requests using this key will be rejected immediately. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => startTransition(() => revokeApiKey(id))}>
            Revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

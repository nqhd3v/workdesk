"use client";

import Link from "next/link";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { CheckCircleIcon, CpuIcon, WarningIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type DeviceListItem = {
  id: string;
  name: string | null;
  online: boolean;
  lastSeen: string | null;
  fw: string | null;
  uptime: string | null;
  battery: number | null;
  power: string | null;
  ip: string | null;
  ssid: string | null;
  rssi: number | null;
  keyName: string | null;
  keyPrefix: string | null;
  keyExpired: boolean;
};

const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>;

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, DeviceListItem>();
const columns = helper.columns([
  helper.accessor("online", {
    header: "Status",
    cell: ({ getValue }) => (
      <Badge variant="outline" className="gap-1">
        {getValue() ? <CheckCircleIcon weight="fill" className="text-status-good" /> : <WarningIcon weight="fill" className="text-status-warning" />}
        {getValue() ? "Online" : "Offline"}
      </Badge>
    ),
  }),
  helper.accessor("id", {
    header: "Device",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium">{row.original.name ?? row.original.id}</span>
        {row.original.name && <Muted>{row.original.id}</Muted>}
        {row.original.fw && <Muted>fw {row.original.fw}</Muted>}
      </div>
    ),
  }),
  helper.accessor("lastSeen", {
    header: "Last seen",
    cell: ({ row }) => (
      <div className="flex flex-col">
        {row.original.lastSeen ?? <Muted>Never</Muted>}
        {row.original.online && row.original.uptime && <Muted>up {row.original.uptime}</Muted>}
      </div>
    ),
  }),
  helper.accessor("battery", {
    header: "Power",
    cell: ({ row }) =>
      row.original.battery === null && !row.original.power ? (
        <Muted>—</Muted>
      ) : (
        <div className="flex flex-col">
          {row.original.battery !== null && <span>{row.original.battery}%</span>}
          {row.original.power && <Muted>{row.original.power}</Muted>}
        </div>
      ),
  }),
  helper.accessor("ip", {
    header: "Network",
    cell: ({ row }) =>
      row.original.ip === null && !row.original.ssid ? (
        <Muted>—</Muted>
      ) : (
        <div className="flex flex-col">
          {row.original.ip && <code>{row.original.ip}</code>}
          <Muted>{[row.original.ssid, row.original.rssi !== null && `${row.original.rssi} dBm`].filter(Boolean).join(" · ")}</Muted>
        </div>
      ),
  }),
  helper.accessor("keyName", {
    header: "API key",
    cell: ({ row }) =>
      row.original.keyName ? (
        <div className="flex flex-col">
          <span>{row.original.keyName}</span>
          <code className="text-muted-foreground">{row.original.keyPrefix}…</code>
          {row.original.keyExpired && <span className="text-destructive">expired</span>}
        </div>
      ) : (
        <Badge variant="destructive">No key</Badge>
      ),
  }),
]);

export function DevicesTable({ data }: { data: DeviceListItem[] }) {
  const table = useTable({ features, columns, data });

  if (data.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CpuIcon />
          </EmptyMedia>
          <EmptyTitle>No devices yet</EmptyTitle>
          <EmptyDescription>Create a Module API key and send one report with it. The device shows up here.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link href="/settings/api-keys" className={buttonVariants({ variant: "outline" })}>
            API keys
          </Link>
        </EmptyContent>
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
            <TableRow key={row.id}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id}>
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

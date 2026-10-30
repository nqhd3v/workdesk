import type { Metadata } from "next";
import { connection } from "next/server";
import { WarningIcon } from "@phosphor-icons/react/dist/ssr";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { MODULE_OFFLINE_AFTER_MS } from "@/lib/board";
import { getDevices } from "@/lib/devices";
import { fromNow } from "@/lib/format";
import { DevicesTable, type DeviceListItem } from "./devices-table";

export const metadata: Metadata = { title: "Devices · Workdesk" };

function uptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${Math.floor(seconds / 60) % 60}m`;
}

// Format on the server so client hydration doesn't depend on the browser's timezone or clock.
function toListItems(devices: Awaited<ReturnType<typeof getDevices>>): DeviceListItem[] {
  const now = Date.now();
  return devices.map(({ id, name, last_seen_at, report, key }) => {
    const seen = last_seen_at ? new Date(last_seen_at).getTime() : null;
    const expires = key ? new Date(key.expires_at).getTime() : null;
    return {
      id,
      name,
      online: seen !== null && now - seen < MODULE_OFFLINE_AFTER_MS,
      lastSeen: seen === null ? null : fromNow(seen, now),
      fw: report?.fw ?? null,
      uptime: report?.uptime_s == null ? null : uptime(report.uptime_s),
      battery: report?.batt_pct ?? null,
      power: report?.power_source ?? null,
      ip: report?.wifi_ip ?? null,
      ssid: report?.wifi_ssid ?? null,
      rssi: report?.wifi_rssi ?? null,
      keyName: key?.name ?? null,
      keyPrefix: key?.key_prefix ?? null,
      keyExpired: expires !== null && expires <= now,
    };
  });
}

// Access is gated in proxy.ts (owner session required).
export default async function DevicesPage() {
  await connection();
  const items = await getDevices().then(toListItems, (err) => {
    console.error("[devices] list", err);
    return null;
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <AutoRefresh />
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold">Devices</h1>
        <p className="text-sm text-muted-foreground">
          {items ? `${items.filter((d) => d.online).length} of ${items.length} online. ` : ""}
          A module registers itself with its first report, using a Module API key.
        </p>
      </div>
      {items ? (
        <DevicesTable data={items} />
      ) : (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>Could not load devices</AlertTitle>
          <AlertDescription>
            Check that <code>supabase/migrations/20261030000000_devices.sql</code> is applied.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

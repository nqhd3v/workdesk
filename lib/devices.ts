import "server-only";
import { supabase } from "@/lib/supabase/admin";

type LatestReport = {
  fw: string | null;
  uptime_s: number | null;
  power_source: string | null;
  batt_pct: number | null;
  wifi_ssid: string | null;
  wifi_rssi: number | null;
  wifi_ip: string | null;
};

export type DeviceRow = {
  id: string;
  name: string | null;
  first_seen_at: string;
  last_seen_at: string | null;
  report: LatestReport | null;
};

export type DeviceKey = { id: string; name: string; key_prefix: string; device_id: string; expires_at: string };

/** All devices (most recently seen first) with their live keys. Callers must be authenticated. */
export async function getDevices() {
  const [devices, keys] = await Promise.all([
    supabase
      .from("devices")
      .select("id, name, first_seen_at, last_seen_at, report:module_reports(fw, uptime_s, power_source, batt_pct, wifi_ssid, wifi_rssi, wifi_ip)")
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .returns<DeviceRow[]>(),
    supabase
      .from("api_keys")
      .select("id, name, key_prefix, device_id, expires_at")
      .not("device_id", "is", null)
      .is("revoked_at", null)
      .returns<DeviceKey[]>(),
  ]);
  if (devices.error) throw devices.error;
  if (keys.error) throw keys.error;

  const keyByDevice = new Map(keys.data.map((k) => [k.device_id, k]));
  return devices.data.map((device) => ({ ...device, key: keyByDevice.get(device.id) ?? null }));
}

import { ApiError, ingestRoute } from "@/lib/api/handler";
import type { ApiKeyRow } from "@/lib/api/keys";
import { modulePayload } from "@/lib/api/schemas";
import { supabase } from "@/lib/supabase/admin";

const UNIQUE_VIOLATION = "23505";

// One key, one device: the first report binds them, and either side refuses a second partner.
async function bindDevice(key: ApiKeyRow, deviceId: string) {
  let bound = key.device_id;
  if (!bound) {
    const { data, error } = await supabase.rpc("bind_module_key", { p_api_key_id: key.id, p_device_id: deviceId });
    if (error?.code === UNIQUE_VIOLATION) {
      throw new ApiError(403, "device_taken", `Device "${deviceId}" already has a key. Revoke it first.`);
    }
    if (error) throw error;
    bound = data as string;
  }
  if (bound !== deviceId) throw new ApiError(403, "device_mismatch", `This key belongs to device "${bound}".`);
}

export const POST = ingestRoute("module", modulePayload, async (data, key) => {
  await bindDevice(key, data.device.id);

  const { data: stored, error } = await supabase.rpc("ingest_module", {
    p_api_key_id: key.id,
    p_report: {
      device_id: data.device.id,
      name: data.device.name ?? null,
      fw: data.device.fw ?? null,
      uptime_s: data.device.uptime_s ?? null,
      power_source: data.power?.source ?? null,
      batt_mv: data.power?.batt_mv ?? null,
      batt_pct: data.power?.batt_pct ?? null,
      wifi_ssid: data.wifi?.ssid ?? null,
      wifi_rssi: data.wifi?.rssi ?? null,
      wifi_ip: data.wifi?.ip ?? null,
      payload: data,
    },
    p_readings: data.readings,
  });
  if (error) throw error;

  return { received: data.readings.length, stored: stored as number };
});

import { ApiError, ingestRoute } from "@/lib/api/handler";
import { modulePayload } from "@/lib/api/schemas";
import { supabase } from "@/lib/supabase/admin";

export const POST = ingestRoute("module", modulePayload, async (data, key) => {
  // A key identifies one module: bind on first report, reject other device ids after.
  if (key.device_id && key.device_id !== data.device.id) {
    throw new ApiError(403, "device_mismatch", `This key belongs to device "${key.device_id}".`);
  }
  if (!key.device_id) {
    await supabase.from("api_keys").update({ device_id: data.device.id }).eq("id", key.id).is("device_id", null);
  }

  const { data: stored, error } = await supabase.rpc("ingest_module", {
    p_api_key_id: key.id,
    p_report: {
      device_id: data.device.id,
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

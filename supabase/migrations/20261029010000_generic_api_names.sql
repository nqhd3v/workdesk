-- Rename ingest APIs to generic, sender-agnostic names:
--   env     -> module       (/api/module)
--   meeting -> events       (/api/events)
--   claude  -> usage_state  (/api/usage-state)

alter type public.api_scope rename value 'env' to 'module';
alter type public.api_scope rename value 'meeting' to 'events';
alter type public.api_scope rename value 'claude' to 'usage_state';

alter table public.env_reports rename to module_reports;
alter table public.env_readings rename to module_readings;
alter table public.meeting_snapshots rename to event_snapshots;
alter table public.claude_usage rename to usage_states;

alter index public.env_reports_device_received_idx rename to module_reports_device_received_idx;
alter index public.meeting_snapshots_received_idx rename to event_snapshots_received_idx;
alter index public.claude_usage_sent_idx rename to usage_states_sent_idx;

-- Contract v2: absolute timestamps instead of relative hours / timezone-less strings.
-- Tables are empty at this point, so columns are replaced rather than converted.
alter table public.usage_states drop column session_reset_in_h;
alter table public.usage_states drop column week_reset_in_h;
alter table public.usage_states add column session_resets_at timestamptz;
alter table public.usage_states add column week_resets_at timestamptz not null;
alter table public.usage_states rename column sent_at to measured_at;
alter index public.usage_states_sent_idx rename to usage_states_measured_idx;
comment on column public.usage_states.session_resets_at is 'null while no session is active';
comment on column public.event_snapshots.events is '[{ id, title, starts_at, ends_at }] (ISO, UTC), sorted by starts_at';

-- plpgsql bodies reference tables by name, so the function is recreated rather than renamed.
drop function public.ingest_env(uuid, jsonb, jsonb);

-- Atomic module ingest: one report row + its readings (duplicates by (device_id, ts) are skipped).
-- Returns the number of new readings stored.
create function public.ingest_module(p_api_key_id uuid, p_report jsonb, p_readings jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_report_id bigint;
  v_inserted integer;
begin
  insert into public.module_reports (
    api_key_id, device_id, fw, uptime_s, power_source, batt_mv, batt_pct,
    wifi_ssid, wifi_rssi, wifi_ip, payload
  )
  values (
    p_api_key_id,
    p_report ->> 'device_id',
    p_report ->> 'fw',
    (p_report ->> 'uptime_s')::integer,
    p_report ->> 'power_source',
    (p_report ->> 'batt_mv')::integer,
    (p_report ->> 'batt_pct')::smallint,
    p_report ->> 'wifi_ssid',
    (p_report ->> 'wifi_rssi')::smallint,
    p_report ->> 'wifi_ip',
    p_report -> 'payload'
  )
  returning id into v_report_id;

  insert into public.module_readings (device_id, ts, report_id, temp_c, hum_pct, pressure_hpa, gas_ohm, iaq, batt_mv)
  select
    p_report ->> 'device_id',
    to_timestamp((r ->> 'ts')::bigint),
    v_report_id,
    (r ->> 'temp_c')::real,
    (r ->> 'hum_pct')::real,
    (r ->> 'pressure_hpa')::real,
    (r ->> 'gas_ohm')::integer,
    (r ->> 'iaq')::real,
    (r ->> 'batt_mv')::integer
  from jsonb_array_elements(p_readings) as r
  on conflict (device_id, ts) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke execute on function public.ingest_module(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_module(uuid, jsonb, jsonb) to service_role;

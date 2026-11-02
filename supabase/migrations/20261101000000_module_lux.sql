-- Light level from an optional BH1750. Modules without one leave it null.
alter table public.module_readings add column lux real;

-- Same as before, and also stores lux.
create or replace function public.ingest_module(p_api_key_id uuid, p_report jsonb, p_readings jsonb)
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

  insert into public.devices (id, name, last_seen_at, last_report_id)
  values (p_report ->> 'device_id', p_report ->> 'name', now(), v_report_id)
  on conflict (id) do update set
    name = coalesce(excluded.name, public.devices.name),
    last_seen_at = excluded.last_seen_at,
    last_report_id = excluded.last_report_id;

  insert into public.module_readings (device_id, ts, report_id, temp_c, hum_pct, pressure_hpa, gas_ohm, iaq, batt_mv, lux)
  select
    p_report ->> 'device_id',
    to_timestamp((r ->> 'ts')::bigint),
    v_report_id,
    (r ->> 'temp_c')::real,
    (r ->> 'hum_pct')::real,
    (r ->> 'pressure_hpa')::real,
    (r ->> 'gas_ohm')::integer,
    (r ->> 'iaq')::real,
    (r ->> 'batt_mv')::integer,
    (r ->> 'lux')::real
  from jsonb_array_elements(p_readings) as r
  on conflict (device_id, ts) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- The return type changes, so it can't be replaced in place.
drop function public.module_series(timestamptz, interval);

-- Average sensor values per bucket, across all devices.
create function public.module_series(p_from timestamptz, p_bucket interval)
returns table (bucket timestamptz, temp_c real, hum_pct real, pressure_hpa real, iaq real, lux real)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    date_bin(p_bucket, r.ts, p_from) as bucket,
    avg(r.temp_c)::real,
    avg(r.hum_pct)::real,
    avg(r.pressure_hpa)::real,
    avg(r.iaq)::real,
    avg(r.lux)::real
  from public.module_readings r
  where r.ts >= p_from
  group by 1
  order by 1;
$$;

revoke execute on function public.module_series(timestamptz, interval) from public, anon, authenticated;
grant execute on function public.module_series(timestamptz, interval) to service_role;

-- Modules as first-class records, one live API key each. A device is registered by its key's first
-- report; battery, wifi and so on stay in module_reports, and last_report_id points at the newest row.

create table public.devices (
  id text primary key check (char_length(id) between 1 and 64),
  -- As reported by the module. Null until a report includes one.
  name text check (char_length(name) <= 64),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_report_id bigint references public.module_reports (id) on delete set null
);
alter table public.devices enable row level security;
create index devices_last_seen_idx on public.devices (last_seen_at desc nulls last);

insert into public.devices (id, first_seen_at, last_seen_at, last_report_id)
select device_id, min(received_at), max(received_at), max(id)
from public.module_reports
group by device_id;

insert into public.devices (id)
select distinct device_id from public.api_keys where device_id is not null
on conflict (id) do nothing;

-- Keys sharing a device would break the index below: keep the one in use, revoke the others.
with ranked as (
  select id, row_number() over (
    partition by device_id
    order by expires_at > now() desc, last_used_at desc nulls last, created_at desc
  ) as rank
  from public.api_keys
  where device_id is not null and revoked_at is null
)
update public.api_keys k
set revoked_at = now()
from ranked r
where k.id = r.id and r.rank > 1;

alter table public.api_keys
  add constraint api_keys_device_id_fkey foreign key (device_id) references public.devices (id);
create unique index api_keys_live_device_idx on public.api_keys (device_id) where revoked_at is null;

-- Newest report across all devices: read every few seconds by the login board and dashboard.
create index module_reports_received_idx on public.module_reports (received_at desc);

-- Binds an unbound key to a device, registering the device if it's new. Returns the key's device id
-- afterwards, which differs from p_device_id if a concurrent report won. Raises unique_violation when
-- another live key holds the device; an expired key doesn't count, so its replacement can take over.
create function public.bind_module_key(p_api_key_id uuid, p_device_id text)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bound text;
begin
  insert into public.devices (id) values (p_device_id) on conflict (id) do nothing;

  update public.api_keys
  set revoked_at = now()
  where device_id = p_device_id and revoked_at is null and expires_at <= now();

  update public.api_keys set device_id = p_device_id where id = p_api_key_id and device_id is null;

  select device_id into v_bound from public.api_keys where id = p_api_key_id;
  return v_bound;
end;
$$;

revoke execute on function public.bind_module_key(uuid, text) from public, anon, authenticated;
grant execute on function public.bind_module_key(uuid, text) to service_role;

-- Same as before, and also keeps the device's name and last-seen pointer current.
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

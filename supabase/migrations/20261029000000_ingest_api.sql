-- API keys + ingest tables for external sources (IoT env module, Google Script meetings, Claude usage).
-- All tables have RLS enabled with no policies: only the server (secret key) can read/write.

create type public.api_scope as enum ('env', 'meeting', 'claude');

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 64),
  scope public.api_scope not null,
  -- First chars of the key, for recognising it in the UI. The full key is never stored.
  key_prefix text not null,
  -- sha256(key) hex. Keys are 256-bit random, so a fast hash is sufficient.
  key_hash text not null unique,
  -- env keys bind to the first device id they report; later mismatches are rejected.
  device_id text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table public.api_keys enable row level security;

-- One row per POST from an env module (device/power/wifi snapshot + raw payload).
create table public.env_reports (
  id bigint generated always as identity primary key,
  api_key_id uuid not null references public.api_keys (id),
  device_id text not null,
  fw text,
  uptime_s integer,
  power_source text,
  batt_mv integer,
  batt_pct smallint,
  wifi_ssid text,
  wifi_rssi smallint,
  wifi_ip text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
alter table public.env_reports enable row level security;
create index env_reports_device_received_idx on public.env_reports (device_id, received_at desc);

-- Individual sensor samples. (device_id, ts) is unique so module retries are idempotent.
create table public.env_readings (
  device_id text not null,
  ts timestamptz not null,
  report_id bigint not null references public.env_reports (id) on delete cascade,
  temp_c real,
  hum_pct real,
  pressure_hpa real,
  gas_ohm integer,
  iaq real,
  batt_mv integer,
  primary key (device_id, ts)
);
alter table public.env_readings enable row level security;

-- Latest upcoming meetings, as a full snapshot per push (dashboard reads the newest row).
create table public.meeting_snapshots (
  id bigint generated always as identity primary key,
  api_key_id uuid not null references public.api_keys (id),
  -- [{ name, starts_at (ISO, UTC), duration_min }]
  events jsonb not null,
  sent_at timestamptz not null,
  received_at timestamptz not null default now()
);
alter table public.meeting_snapshots enable row level security;
create index meeting_snapshots_received_idx on public.meeting_snapshots (received_at desc);

-- Claude plan usage over time.
create table public.claude_usage (
  id bigint generated always as identity primary key,
  api_key_id uuid not null references public.api_keys (id),
  session_pct real not null,
  week_pct real not null,
  session_reset_in_h real,
  week_reset_in_h real not null,
  sent_at timestamptz not null,
  received_at timestamptz not null default now()
);
alter table public.claude_usage enable row level security;
create index claude_usage_sent_idx on public.claude_usage (sent_at desc);

-- Atomic env ingest: one report row + its readings (duplicates by (device_id, ts) are skipped).
-- Returns the number of new readings stored.
create function public.ingest_env(p_api_key_id uuid, p_report jsonb, p_readings jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_report_id bigint;
  v_inserted integer;
begin
  insert into public.env_reports (
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

  insert into public.env_readings (device_id, ts, report_id, temp_c, hum_pct, pressure_hpa, gas_ohm, iaq, batt_mv)
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

-- Only the server-side secret key (service_role) may call it.
revoke execute on function public.ingest_env(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_env(uuid, jsonb, jsonb) to service_role;

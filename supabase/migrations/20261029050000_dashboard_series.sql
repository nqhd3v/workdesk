-- Time-bucketed series for the dashboard charts. Bucketing in the database keeps responses small
-- (a module reporting every 2 min sends ~21k readings a month) and under PostgREST's row cap.
-- Buckets are aligned to p_from; empty buckets are omitted (the client fills gaps).

-- Average sensor values per bucket, across all devices.
create function public.module_series(p_from timestamptz, p_bucket interval)
returns table (bucket timestamptz, temp_c real, hum_pct real, pressure_hpa real, iaq real)
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
    avg(r.iaq)::real
  from public.module_readings r
  where r.ts >= p_from
  group by 1
  order by 1;
$$;

-- Peak usage per tool per bucket (usage climbs until a reset, so the max is the bucket's high-water mark).
create function public.usage_series(p_from timestamptz, p_bucket interval)
returns table (bucket timestamptz, name public.usage_tool, session_pct real, week_pct real)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    date_bin(p_bucket, u.measured_at, p_from) as bucket,
    u.name,
    max(u.session_pct)::real,
    max(u.week_pct)::real
  from public.usage_states u
  where u.measured_at >= p_from
  group by 1, 2
  order by 1, 2;
$$;

create index module_readings_ts_idx on public.module_readings (ts desc);

revoke execute on function public.module_series(timestamptz, interval) from public, anon, authenticated;
grant execute on function public.module_series(timestamptz, interval) to service_role;
revoke execute on function public.usage_series(timestamptz, interval) from public, anon, authenticated;
grant execute on function public.usage_series(timestamptz, interval) to service_role;

-- Where a module sits, for the dashboard map. Null until it's placed.
alter table public.devices
  add column latitude double precision check (latitude between -90 and 90),
  add column longitude double precision check (longitude between -180 and 180),
  add constraint devices_location_check check ((latitude is null) = (longitude is null));

-- The signature changes, so it can't be replaced in place.
drop function public.module_series(timestamptz, interval);

-- Average sensor values per bucket for one device.
create function public.module_series(p_from timestamptz, p_bucket interval, p_device text)
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
  where r.ts >= p_from and r.device_id = p_device
  group by 1
  order by 1;
$$;

revoke execute on function public.module_series(timestamptz, interval, text) from public, anon, authenticated;
grant execute on function public.module_series(timestamptz, interval, text) to service_role;

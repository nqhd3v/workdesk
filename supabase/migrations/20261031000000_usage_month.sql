-- Copilot has one monthly limit and no session or week, so each window is now optional per tool.
alter table public.usage_states
  alter column session_pct drop not null,
  alter column week_pct drop not null,
  alter column week_resets_at drop not null,
  add column month_pct real,
  add column month_resets_at timestamptz;

-- The return type changes, so it can't be replaced in place.
drop function public.usage_series(timestamptz, interval);

-- Peak usage per tool per bucket (usage climbs until a reset, so the max is the bucket's high-water mark).
create function public.usage_series(p_from timestamptz, p_bucket interval)
returns table (bucket timestamptz, name public.usage_tool, session_pct real, week_pct real, month_pct real)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    date_bin(p_bucket, u.measured_at, p_from) as bucket,
    u.name,
    max(u.session_pct)::real,
    max(u.week_pct)::real,
    max(u.month_pct)::real
  from public.usage_states u
  where u.measured_at >= p_from
  group by 1, 2
  order by 1, 2;
$$;

revoke execute on function public.usage_series(timestamptz, interval) from public, anon, authenticated;
grant execute on function public.usage_series(timestamptz, interval) to service_role;

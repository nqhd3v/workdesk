-- Per-key request counters for rate-limited endpoints (fixed windows).
create table public.api_rate_limits (
  api_key_id uuid not null references public.api_keys (id) on delete cascade,
  window_start timestamptz not null,
  hits integer not null,
  primary key (api_key_id, window_start)
);
alter table public.api_rate_limits enable row level security;

-- Counts one request for the key in the current window and returns the window's total so far.
-- Atomic under concurrency; also drops the key's older windows so the table stays tiny.
create function public.hit_rate_limit(p_api_key_id uuid, p_window_s integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  v_hits integer;
begin
  insert into public.api_rate_limits (api_key_id, window_start, hits)
  values (p_api_key_id, v_window, 1)
  on conflict (api_key_id, window_start) do update set hits = public.api_rate_limits.hits + 1
  returning hits into v_hits;

  delete from public.api_rate_limits where api_key_id = p_api_key_id and window_start < v_window;
  return v_hits;
end;
$$;

revoke execute on function public.hit_rate_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(uuid, integer) to service_role;

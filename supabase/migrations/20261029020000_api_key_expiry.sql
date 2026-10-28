-- Every API key expires, at most one year after creation.
alter table public.api_keys add column expires_at timestamptz;
update public.api_keys set expires_at = least(created_at + interval '1 year', now() + interval '1 year') where expires_at is null;
alter table public.api_keys alter column expires_at set not null;
alter table public.api_keys
  add constraint api_keys_expiry_max_one_year check (expires_at <= created_at + interval '1 year' + interval '1 day');

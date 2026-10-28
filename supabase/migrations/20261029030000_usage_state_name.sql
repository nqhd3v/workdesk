-- Usage state is pushed for several tools; `name` identifies which one.
create type public.usage_tool as enum ('claude', 'copilot');

alter table public.usage_states add column name public.usage_tool;
-- Rows recorded before this column existed all came from Claude.
update public.usage_states set name = 'claude' where name is null;
alter table public.usage_states alter column name set not null;

drop index public.usage_states_measured_idx;
create index usage_states_name_measured_idx on public.usage_states (name, measured_at desc);

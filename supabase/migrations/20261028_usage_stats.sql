-- Per-device usage statistics (snippet use counts + characters saved), so the
-- "time saved" and "Uses" figures can be combined across all of a user's
-- devices. Each device owns exactly one row and only ever overwrites its own
-- totals, so there are no merge conflicts: readers sum the rows.
create table if not exists public.usage_stats (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id  text not null check (char_length(device_id) between 8 and 64),
  platform   text check (platform is null or char_length(platform) <= 32),
  by_key     jsonb not null default '{}'::jsonb,
  totals     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id),
  constraint usage_stats_size check (pg_column_size(by_key) < 262144 and pg_column_size(totals) < 4096)
);

alter table public.usage_stats enable row level security;

drop policy if exists usage_stats_select on public.usage_stats;
create policy usage_stats_select on public.usage_stats
  for select to authenticated using (user_id = auth.uid());

drop policy if exists usage_stats_insert on public.usage_stats;
create policy usage_stats_insert on public.usage_stats
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists usage_stats_update on public.usage_stats;
create policy usage_stats_update on public.usage_stats
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists usage_stats_delete on public.usage_stats;
create policy usage_stats_delete on public.usage_stats
  for delete to authenticated using (user_id = auth.uid());

revoke all on public.usage_stats from anon;
grant select, insert, update, delete on public.usage_stats to authenticated;

-- ===========================================================================
-- 2026-10-17 security hardening. Run AFTER schema.sql and billing.sql.
-- Idempotent: safe to run more than once.
--
-- F1  profiles: no bulk listing; discovery via find_profile / search_profiles
-- F2  friendships: requests can only be created as 'pending';
--     library shares only to accepted friends
-- F4  libraries <-> library_shares policy recursion removed
--     (SECURITY DEFINER helpers that only answer yes/no about the caller)
-- F3  is handled in billing.sql: admins are granted by UUID, never by email.
--
-- Deploy order: (1) this file's helpers + RPCs are additive and harmless;
-- (2) ship app builds that call the RPCs; (3) the policy changes take effect
-- for everyone. Running the whole file at once is also safe: current desktop
-- builds fall back to the old query only when the RPCs don't exist.
-- The same block is in schema.sql, so re-running schema.sql keeps these rules.
-- Verified locally with supabase/tests/run.sh.
-- ===========================================================================

-- --- Hardened access rules (2026-10-17) -------------------------------------
-- Helpers are SECURITY DEFINER so policies can consult other tables without
-- re-entering RLS (this is what removed the libraries <-> library_shares
-- "infinite recursion detected in policy" error). Each helper only answers a
-- yes/no question about the CALLER (auth.uid()); none returns other users' data.

create or replace function public.owns_library(p_library uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.libraries where id = p_library and owner_id = auth.uid());
$$;
create or replace function public.library_shared_with_me(p_library uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.library_shares where library_id = p_library and shared_with = auth.uid());
$$;
create or replace function public.is_friend_or_pending(p_other uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships
                 where (requester_id = auth.uid() and addressee_id = p_other)
                    or (addressee_id = auth.uid() and requester_id = p_other));
$$;
create or replace function public.is_accepted_friend(p_other uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.friendships
                 where status = 'accepted'
                   and ((requester_id = auth.uid() and addressee_id = p_other)
                     or (addressee_id = auth.uid() and requester_id = p_other)));
$$;
-- A share only counts while the two people are still accepted friends.
create or replace function public.shares_a_library_with_me(p_owner uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select public.is_accepted_friend(p_owner)
     and exists (select 1 from public.libraries l join public.library_shares s on s.library_id = l.id
                 where l.owner_id = p_owner and s.shared_with = auth.uid());
$$;
revoke execute on function public.owns_library(uuid), public.library_shared_with_me(uuid),
  public.is_friend_or_pending(uuid), public.is_accepted_friend(uuid),
  public.shares_a_library_with_me(uuid) from public, anon;
grant execute on function public.owns_library(uuid), public.library_shared_with_me(uuid),
  public.is_friend_or_pending(uuid), public.is_accepted_friend(uuid),
  public.shares_a_library_with_me(uuid) to authenticated;

-- Usernames are unique ignoring case, so "ALICE" can't impersonate "alice".
-- If existing rows collide, the index is skipped with a warning: rename one of
-- them, then re-run this file.
do $$
begin
  if exists (select 1 from public.profiles group by lower(username) having count(*) > 1) then
    raise warning 'profiles has usernames that differ only by case; resolve them and re-run to add profiles_username_lower_key';
  else
    create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));
  end if;
end $$;

-- profiles: visible only to yourself, people you have a friendship row with,
-- and accepted friends who share a library with you. No bulk listing.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (
    id = auth.uid() or public.is_friend_or_pending(id) or public.shares_a_library_with_me(id));

-- friendships: a request can only be CREATED as pending. Only the addressee can
-- accept it (friendships_update + the party-lock trigger above).
drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (requester_id = auth.uid() and status = 'pending');

-- libraries: a shared library is readable only while the owner is still an
-- accepted friend; unfriending ends access even if the share row remains.
drop policy if exists libraries_shared_select on public.libraries;
create policy libraries_shared_select on public.libraries
  for select to authenticated
  using (public.library_shared_with_me(id) and public.is_accepted_friend(owner_id));

-- library_shares: the owner manages shares, and may share only with an accepted friend.
drop policy if exists library_shares_owner_all on public.library_shares;
create policy library_shares_owner_all on public.library_shares
  for all to authenticated
  using (public.owns_library(library_id))
  with check (public.owns_library(library_id) and public.is_accepted_friend(shared_with));

-- Discovery RPCs: the only way to find someone you aren't connected to yet.
-- find_profile: exact username (case-insensitive) -> id to send a request to.
create or replace function public.find_profile(p_username text)
  returns table (id uuid, username text, display_name text)
  language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name from public.profiles p
  where auth.uid() is not null and lower(p.username) = lower(trim(p_username)) and p.id <> auth.uid()
  order by (p.username = trim(p_username)) desc, p.created_at
  limit 1;
$$;
-- search_profiles: 3+ character prefix, 5 results, names only (no id, no dates).
drop function if exists public.search_profiles(text);
create function public.search_profiles(p_prefix text)
  returns table (username text, display_name text)
  language sql stable security definer set search_path = public as $$
  select p.username, p.display_name from public.profiles p
  where auth.uid() is not null
    and length(trim(p_prefix)) >= 3
    and starts_with(lower(p.username), lower(trim(p_prefix)))
    and p.id <> auth.uid()
  order by p.username limit 5;
$$;
revoke execute on function public.find_profile(text), public.search_profiles(text) from public, anon;
grant  execute on function public.find_profile(text), public.search_profiles(text) to authenticated;
-- --- end hardened access rules ----------------------------------------------

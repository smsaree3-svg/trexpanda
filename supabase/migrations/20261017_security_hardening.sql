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
-- Verified locally with supabase/tests (see supabase/tests/README.md).
-- ===========================================================================
-- Helpers: each only answers a yes/no question about the CALLER (auth.uid()).

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
create or replace function public.shares_a_library_with_me(p_owner uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.libraries l join public.library_shares s on s.library_id = l.id
                 where l.owner_id = p_owner and s.shared_with = auth.uid());
$$;
revoke execute on function public.owns_library(uuid), public.library_shared_with_me(uuid),
  public.is_friend_or_pending(uuid), public.is_accepted_friend(uuid),
  public.shares_a_library_with_me(uuid) from public, anon;
grant execute on function public.owns_library(uuid), public.library_shared_with_me(uuid),
  public.is_friend_or_pending(uuid), public.is_accepted_friend(uuid),
  public.shares_a_library_with_me(uuid) to authenticated;

-- Library policies rewritten on the helpers (fixes the recursion).
drop policy if exists libraries_shared_select on public.libraries;
create policy libraries_shared_select on public.libraries
  for select to authenticated using (public.library_shared_with_me(id));

-- F2 (defence in depth): an owner may share only with an accepted friend.
drop policy if exists library_shares_owner_all on public.library_shares;
create policy library_shares_owner_all on public.library_shares
  for all to authenticated
  using (public.owns_library(library_id))
  with check (public.owns_library(library_id) and public.is_accepted_friend(shared_with));

-- F1. Profiles: no bulk listing. Visible = yourself, anyone you have a friendship row
-- with (any status), and owners of libraries shared with you.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (
    id = auth.uid() or public.is_friend_or_pending(id) or public.shares_a_library_with_me(id));

-- Discovery through two narrow RPCs returning id/username/display_name only.
create or replace function public.find_profile(p_username text)
  returns table (id uuid, username text, display_name text)
  language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name from public.profiles p
  where auth.uid() is not null and lower(p.username) = lower(trim(p_username)) and p.id <> auth.uid()
  limit 1;
$$;
create or replace function public.search_profiles(p_prefix text)
  returns table (id uuid, username text, display_name text)
  language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name from public.profiles p
  where auth.uid() is not null
    and length(trim(p_prefix)) >= 3
    and starts_with(lower(p.username), lower(trim(p_prefix)))
    and p.id <> auth.uid()
  order by p.username limit 5;
$$;
revoke execute on function public.find_profile(text), public.search_profiles(text) from public, anon;
grant  execute on function public.find_profile(text), public.search_profiles(text) to authenticated;

-- F2. A request can only be CREATED as pending; only the addressee can accept it
-- (the existing UPDATE policy + party-lock trigger already enforce that).
drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (requester_id = auth.uid() and status = 'pending');

-- F3. Admins are granted by explicit user id only, never by matching an email.
-- Delete the email-based seed at the end of billing.sql. Operator step, by hand,
-- with a UUID you have confirmed is your own account:
--   insert into public.admins(user_id) values ('<your-verified-user-uuid>') on conflict do nothing;

-- ===========================================================================
-- Trexpanda cloud schema (Supabase / Postgres)
--
-- Run this ONCE in your Supabase project: Dashboard -> SQL Editor -> New query
-- -> paste -> Run. It is idempotent, so re-running it is safe.
--
-- What it sets up:
--   profiles        one public identity row per user (for friend lookups)
--   libraries       a named bag of snippets owned by a user
--   friendships     pending/accepted links between two users
--   library_shares  which friend a given library is shared with
--
-- Access is enforced entirely by Row Level Security (RLS) below, so the anon
-- key shipped in the app can't be used to read other people's data.
-- ===========================================================================

-- --- Tables ----------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text unique not null,
  display_name text,
  created_at   timestamptz not null default now()
);

create table if not exists public.libraries (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  name       text not null default 'My Snippets',
  snippets   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists libraries_owner_idx on public.libraries(owner_id);

create table if not exists public.friendships (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references auth.users(id) on delete cascade,
  addressee_id  uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','accepted')),
  created_at    timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index if not exists friendships_addressee_idx on public.friendships(addressee_id);
create index if not exists friendships_requester_idx on public.friendships(requester_id);

create table if not exists public.library_shares (
  id          uuid primary key default gen_random_uuid(),
  library_id  uuid not null references public.libraries(id) on delete cascade,
  shared_with uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (library_id, shared_with)
);
create index if not exists library_shares_shared_with_idx on public.library_shares(shared_with);

-- --- Row Level Security -----------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.libraries      enable row level security;
alter table public.friendships    enable row level security;
alter table public.library_shares enable row level security;

-- profiles: any signed-in user can look up profiles (needed to add friends by
-- username); you may only create/update your OWN row. No email is stored here.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- friendships: you can see and act on rows you are part of.
drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated with check (requester_id = auth.uid());

-- Only the ADDRESSEE may update a friendship row — that update IS the acceptance.
-- The previous policy let EITHER party update (and, with no WITH CHECK, reused
-- USING as the check), so a requester could self-accept their own pending request
-- without the addressee's consent. Pin the updater to the addressee on both sides.
drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships
  for update to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid());

-- Belt-and-suspenders: an accept must not be able to rewrite either party to a
-- third user (RLS WITH CHECK can't compare against the OLD row, so use a trigger).
create or replace function public.friendships_lock_parties()
  returns trigger language plpgsql as $$
  begin
    if new.requester_id <> old.requester_id or new.addressee_id <> old.addressee_id then
      raise exception 'cannot change friendship parties';
    end if;
    return new;
  end;
  $$;
drop trigger if exists friendships_no_party_change on public.friendships;
create trigger friendships_no_party_change
  before update on public.friendships
  for each row execute function public.friendships_lock_parties();

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- libraries: the owner has full control; a friend the library is shared with
-- can read it. (Postgres OR-combines policies for the same command.)
drop policy if exists libraries_owner_all on public.libraries;
create policy libraries_owner_all on public.libraries
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists libraries_shared_select on public.libraries;
create policy libraries_shared_select on public.libraries
  for select to authenticated
  using (exists (
    select 1 from public.library_shares s
    where s.library_id = libraries.id and s.shared_with = auth.uid()
  ));

-- library_shares: the library's owner manages shares; the recipient can see the
-- rows that name them.
drop policy if exists library_shares_owner_all on public.library_shares;
create policy library_shares_owner_all on public.library_shares
  for all to authenticated
  using (exists (
    select 1 from public.libraries l
    where l.id = library_shares.library_id and l.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.libraries l
    where l.id = library_shares.library_id and l.owner_id = auth.uid()
  ));

drop policy if exists library_shares_recipient_select on public.library_shares;
create policy library_shares_recipient_select on public.library_shares
  for select to authenticated using (shared_with = auth.uid());

-- --- Convenience: keep updated_at fresh on libraries ------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists libraries_touch on public.libraries;
create trigger libraries_touch before update on public.libraries
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Personal snippets (per-user, cross-device sync).
--
-- Each row is one of the OWNER's personal snippets, identified by a stable id
-- (so a trigger rename keeps its identity). `updated_at` drives last-write-wins
-- merging; `deleted_at` is a soft-delete tombstone so a deletion on one device
-- propagates to the others instead of reappearing on the next pull. The desktop
-- app and the Android app both read/write this table as the signed-in user.
-- (Distinct from `libraries`, which is for SHARING snippet sets with friends.)
-- ---------------------------------------------------------------------------
create table if not exists public.snippets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  trigger     text,
  replacement text not null default '',
  label       text,
  html        text,
  attachment  jsonb,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists snippets_user_idx on public.snippets(user_id);
create index if not exists snippets_user_updated_idx on public.snippets(user_id, updated_at);

alter table public.snippets enable row level security;

drop policy if exists snippets_select_own on public.snippets;
create policy snippets_select_own on public.snippets
  for select to authenticated using (user_id = auth.uid());

drop policy if exists snippets_insert_own on public.snippets;
create policy snippets_insert_own on public.snippets
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists snippets_update_own on public.snippets;
create policy snippets_update_own on public.snippets
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists snippets_delete_own on public.snippets;
create policy snippets_delete_own on public.snippets
  for delete to authenticated using (user_id = auth.uid());

-- ===========================================================================
-- Trexpanda billing + trial + coupons + admin schema (Supabase / Postgres)
--
-- Run ONCE, AFTER schema.sql:  Dashboard -> SQL Editor -> New query -> Run.
-- Idempotent; safe to re-run.
--
-- Model (no card upfront):
--   * New account => 30-day free trial (anchored to auth.users.created_at).
--     Full features EXCEPT export.
--   * Pro       => active Stripe subscription (subscriptions table).
--   * Unlocked  => a coupon/comp grant (grants table), optionally time-limited.
--   * Expired   => trial over, no subscription, no grant. App is read-only.
--
-- Tables:
--   subscriptions        Stripe subscription state (written by the webhook only)
--   grants               coupon/comp unlocks, one row per user
--   coupons              redeemable codes (admin-created)
--   coupon_redemptions   who redeemed what (one per user per code)
--   admins               which users are admins
--
-- Security: clients can READ only their own subscription/grant/admin-flag rows.
-- Everything privileged (redeeming a code, creating coupons, listing users,
-- granting/revoking) goes through SECURITY DEFINER functions that enforce the
-- rules server-side. Being admin cannot be faked from the app.
-- ===========================================================================

-- --- subscriptions (Stripe) ------------------------------------------------
create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  price_id               text,
  status                 text not null default 'incomplete',
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  updated_at             timestamptz not null default now()
);
create index if not exists subscriptions_customer_idx on public.subscriptions(stripe_customer_id);
alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (user_id = auth.uid());

-- --- grants (coupon / comp unlocks) ----------------------------------------
create table if not exists public.grants (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  unlocked_until timestamptz,               -- NULL => lifetime
  source         text not null default 'coupon',  -- 'coupon' | 'admin'
  note           text,
  updated_at     timestamptz not null default now()
);
alter table public.grants enable row level security;
drop policy if exists grants_select_own on public.grants;
create policy grants_select_own on public.grants
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies => only SECURITY DEFINER functions write.

-- --- coupons ---------------------------------------------------------------
create table if not exists public.coupons (
  code            text primary key,               -- stored UPPERCASE
  kind            text not null default 'lifetime' check (kind in ('lifetime','days')),
  days            integer,                         -- required when kind='days'
  max_redemptions integer,                         -- NULL => unlimited
  times_redeemed  integer not null default 0,
  expires_at      timestamptz,                     -- code validity (NULL => none)
  batch           text,                            -- optional campaign label
  active          boolean not null default true,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
alter table public.coupons enable row level security;
-- No policies for authenticated => clients cannot read/enumerate codes.
-- Admins reach coupons only through the SECURITY DEFINER functions below.

-- --- coupon redemptions ----------------------------------------------------
create table if not exists public.coupon_redemptions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null references public.coupons(code) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  unique (code, user_id)
);
create index if not exists coupon_redemptions_user_idx on public.coupon_redemptions(user_id);
alter table public.coupon_redemptions enable row level security;
drop policy if exists coupon_redemptions_select_own on public.coupon_redemptions;
create policy coupon_redemptions_select_own on public.coupon_redemptions
  for select to authenticated using (user_id = auth.uid());

-- --- admins ----------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
drop policy if exists admins_select_own on public.admins;
create policy admins_select_own on public.admins
  for select to authenticated using (user_id = auth.uid());

-- ===========================================================================
-- Helpers
-- ===========================================================================

create or replace function public.is_admin(uid uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = uid);
$$;

-- Does this user currently have paid access (Stripe sub OR active grant)?
create or replace function public.is_paid(uid uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from public.subscriptions s
            where s.user_id = uid and s.status in ('active','trialing','past_due'))
    or
    exists (select 1 from public.grants g
            where g.user_id = uid and (g.unlocked_until is null or g.unlocked_until > now()));
$$;

-- Random human-friendly code (no ambiguous chars).
create or replace function public._gen_code(len integer default 10)
  returns text language plpgsql as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  res text := '';
  i integer;
begin
  for i in 1..len loop
    res := res || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return res;
end;
$$;

-- ===========================================================================
-- User-facing: redeem a coupon
-- ===========================================================================
create or replace function public.redeem_coupon(p_code text)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_c public.coupons%rowtype;
  v_has_grant boolean := false;
  v_until timestamptz;
  v_new_until timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'You must be signed in.');
  end if;
  if v_code = '' then
    return jsonb_build_object('ok', false, 'error', 'Enter a code.');
  end if;

  select * into v_c from public.coupons where code = v_code for update;
  if not found or v_c.active is not true then
    return jsonb_build_object('ok', false, 'error', 'Invalid or inactive code.');
  end if;
  if v_c.expires_at is not null and v_c.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'This code has expired.');
  end if;
  if v_c.max_redemptions is not null and v_c.times_redeemed >= v_c.max_redemptions then
    return jsonb_build_object('ok', false, 'error', 'This code has reached its redemption limit.');
  end if;
  if exists (select 1 from public.coupon_redemptions r where r.code = v_code and r.user_id = v_uid) then
    return jsonb_build_object('ok', false, 'error', 'You have already redeemed this code.');
  end if;

  insert into public.coupon_redemptions(code, user_id) values (v_code, v_uid);
  update public.coupons set times_redeemed = times_redeemed + 1 where code = v_code;

  -- Determine the new grant expiry, extending any existing grant.
  select true, g.unlocked_until into v_has_grant, v_until
    from public.grants g where g.user_id = v_uid;
  if not found then v_has_grant := false; end if;

  if v_c.kind = 'lifetime' then
    v_new_until := null;
  elsif v_has_grant and v_until is null then
    v_new_until := null;                      -- already lifetime; keep it
  else
    v_new_until := greatest(now(), coalesce(v_until, now())) + make_interval(days => coalesce(v_c.days, 0));
  end if;

  insert into public.grants(user_id, unlocked_until, source, note, updated_at)
    values (v_uid, v_new_until, 'coupon', 'redeemed ' || v_code, now())
  on conflict (user_id) do update
    set unlocked_until = excluded.unlocked_until, source = 'coupon',
        note = excluded.note, updated_at = now();

  return jsonb_build_object('ok', true, 'kind', v_c.kind, 'unlocked_until', v_new_until);
end;
$$;

-- ===========================================================================
-- Admin: create coupons
-- ===========================================================================
create or replace function public.admin_create_coupon(
  p_code text default null,
  p_kind text default 'lifetime',
  p_days integer default null,
  p_max_redemptions integer default null,
  p_expires_at timestamptz default null,
  p_batch text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_code, public._gen_code(10))));
begin
  if not public.is_admin(v_uid) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_kind not in ('lifetime','days') then
    return jsonb_build_object('ok', false, 'error', 'kind must be lifetime or days');
  end if;
  if p_kind = 'days' and (p_days is null or p_days <= 0) then
    return jsonb_build_object('ok', false, 'error', 'days must be > 0 for a days coupon');
  end if;

  begin
    insert into public.coupons(code, kind, days, max_redemptions, expires_at, batch, created_by)
      values (v_code, p_kind, case when p_kind='days' then p_days else null end,
              p_max_redemptions, p_expires_at, p_batch, v_uid);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'That code already exists.');
  end;

  return jsonb_build_object('ok', true, 'code', v_code, 'kind', p_kind, 'days', p_days,
                            'max_redemptions', p_max_redemptions, 'expires_at', p_expires_at,
                            'batch', p_batch);
end;
$$;

create or replace function public.admin_create_coupons_bulk(
  p_count integer,
  p_prefix text default '',
  p_kind text default 'lifetime',
  p_days integer default null,
  p_max_redemptions integer default 1,
  p_expires_at timestamptz default null,
  p_batch text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_codes text[] := '{}';
  v_code text;
  v_i integer;
  v_tries integer;
begin
  if not public.is_admin(v_uid) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 500 then
    return jsonb_build_object('ok', false, 'error', 'count must be between 1 and 500');
  end if;
  if p_kind not in ('lifetime','days') then
    return jsonb_build_object('ok', false, 'error', 'kind must be lifetime or days');
  end if;
  if p_kind = 'days' and (p_days is null or p_days <= 0) then
    return jsonb_build_object('ok', false, 'error', 'days must be > 0 for a days coupon');
  end if;

  for v_i in 1..p_count loop
    v_tries := 0;
    loop
      v_code := upper(btrim(coalesce(p_prefix, ''))) || public._gen_code(8);
      begin
        insert into public.coupons(code, kind, days, max_redemptions, expires_at, batch, created_by)
          values (v_code, p_kind, case when p_kind='days' then p_days else null end,
                  p_max_redemptions, p_expires_at, coalesce(p_batch, 'bulk'), v_uid);
        v_codes := array_append(v_codes, v_code);
        exit;
      exception when unique_violation then
        v_tries := v_tries + 1;
        if v_tries > 5 then raise exception 'Could not generate a unique code'; end if;
      end;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'count', array_length(v_codes,1), 'codes', to_jsonb(v_codes),
                            'batch', coalesce(p_batch,'bulk'));
end;
$$;

-- ===========================================================================
-- Admin: grant / revoke Pro directly (comp, no code)
-- ===========================================================================
create or replace function public.admin_grant_user(p_user uuid, p_days integer default null, p_note text default null)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_until timestamptz;
begin
  if not public.is_admin(v_uid) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_days is null then v_until := null;                       -- lifetime
  else v_until := now() + make_interval(days => p_days); end if;

  insert into public.grants(user_id, unlocked_until, source, note, updated_at)
    values (p_user, v_until, 'admin', coalesce(p_note,'admin grant'), now())
  on conflict (user_id) do update
    set unlocked_until = excluded.unlocked_until, source = 'admin',
        note = excluded.note, updated_at = now();

  return jsonb_build_object('ok', true, 'user_id', p_user, 'unlocked_until', v_until);
end;
$$;

create or replace function public.admin_revoke_user(p_user uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.is_admin(v_uid) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  delete from public.grants where user_id = p_user;
  -- NOTE: this removes coupon/comp access only. A paid Stripe subscription is
  -- unaffected and must be canceled in Stripe (or via the user's billing portal).
  return jsonb_build_object('ok', true, 'user_id', p_user);
end;
$$;

-- ===========================================================================
-- Admin: read-only views
-- ===========================================================================
create or replace function public.admin_list_users(p_limit integer default 200, p_offset integer default 0)
  returns table (
    id uuid, email text, created_at timestamptz,
    sub_status text, sub_period_end timestamptz, cancel_at_period_end boolean,
    has_grant boolean, grant_unlocked_until timestamptz, grant_source text,
    is_admin boolean
  ) language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.created_at,
           s.status, s.current_period_end, s.cancel_at_period_end,
           (g.user_id is not null) as has_grant, g.unlocked_until, g.source,
           (a.user_id is not null) as is_admin
    from auth.users u
    left join public.subscriptions s on s.user_id = u.id
    left join public.grants g on g.user_id = u.id
    left join public.admins a on a.user_id = u.id
    order by u.created_at desc
    limit greatest(1, least(coalesce(p_limit,200), 1000))
    offset greatest(0, coalesce(p_offset,0));
end;
$$;

create or replace function public.admin_list_coupons(p_limit integer default 500)
  returns table (
    code text, kind text, days integer, max_redemptions integer, times_redeemed integer,
    expires_at timestamptz, batch text, active boolean, created_at timestamptz
  ) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select c.code, c.kind, c.days, c.max_redemptions, c.times_redeemed,
           c.expires_at, c.batch, c.active, c.created_at
    from public.coupons c
    order by c.created_at desc
    limit greatest(1, least(coalesce(p_limit,500), 2000));
end;
$$;

-- Users whose trial ends within the next p_days days and who aren't paid.
create or replace function public.admin_trial_ending(p_days integer default 5)
  returns table (id uuid, email text, created_at timestamptz, trial_ends_at timestamptz)
  language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, u.created_at, (u.created_at + interval '30 days') as trial_ends_at
    from auth.users u
    where (u.created_at + interval '30 days') between now() and now() + make_interval(days => greatest(1,coalesce(p_days,5)))
      and not public.is_paid(u.id)
    order by trial_ends_at asc;
end;
$$;

-- Allow signed-in users to call these RPCs (the functions enforce their own rules).
grant execute on function public.redeem_coupon(text) to authenticated;
grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.admin_create_coupon(text,text,integer,integer,timestamptz,text) to authenticated;
grant execute on function public.admin_create_coupons_bulk(integer,text,text,integer,integer,timestamptz,text) to authenticated;
grant execute on function public.admin_grant_user(uuid,integer,text) to authenticated;
grant execute on function public.admin_revoke_user(uuid) to authenticated;
grant execute on function public.admin_list_users(integer,integer) to authenticated;
grant execute on function public.admin_list_coupons(integer) to authenticated;
grant execute on function public.admin_trial_ending(integer) to authenticated;

-- ===========================================================================
-- Seed the admin. Run this AFTER hello@trexpanda.com has signed into the app
-- once (so its auth.users row exists). Re-run any time; it's idempotent.
-- ===========================================================================
insert into public.admins(user_id)
  select id from auth.users where lower(email) = 'hello@trexpanda.com'
  on conflict (user_id) do nothing;

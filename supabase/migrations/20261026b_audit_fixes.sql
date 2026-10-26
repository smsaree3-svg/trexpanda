-- ===========================================================================
-- 2026-10-26 (b) audit fixes. Idempotent.
--
-- 1. is_paid(uuid) / is_admin(uuid) answered "is this user paying / an admin?"
--    for ANY user id, even to signed-out callers (anon keeps Supabase's default
--    EXECUTE grant). They are only needed inside SECURITY DEFINER functions,
--    which run as the owner, so clients lose nothing. is_admin() (no argument,
--    "am I an admin?") stays available to signed-in users.
-- 2. delete_my_account() also refuses while a checkout is still completing
--    ('incomplete'), so a payment can't land on an account that no longer exists.
-- ===========================================================================

revoke execute on function public.is_paid(uuid)  from public, anon, authenticated;
revoke execute on function public.is_admin(uuid) from public, anon, authenticated;

create or replace function public.delete_my_account()
  returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.subscriptions s
    where s.user_id = v_uid
      and s.status in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete')
      and not coalesce(s.cancel_at_period_end, false)
  ) then
    return jsonb_build_object('ok', false, 'error', 'active_subscription',
      'message', 'Cancel your Trexpanda subscription first (Account > Manage billing), then delete your account.');
  end if;
  delete from auth.users where id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

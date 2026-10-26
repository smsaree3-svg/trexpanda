-- ===========================================================================
-- 2026-10-26 In-app account deletion (required by Google Play and the App Store).
-- Run AFTER schema.sql, billing.sql and 20261017_security_hardening.sql.
-- Idempotent: safe to run more than once.
--
-- delete_my_account() deletes ONLY the caller's own auth.users row. Every table
-- that references auth.users cascades (profiles, libraries, library_shares,
-- friendships, snippets, subscriptions, grants, coupon_redemptions, free_usage,
-- admins); coupons.created_by is set to null. Nothing about other users changes.
--
-- It refuses while a paid Stripe subscription is still active, so nobody keeps
-- being charged for an account that no longer exists: the user cancels in the
-- billing portal first (the subscription then ends at period end or at once).
-- ===========================================================================

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
    return jsonb_build_object(
      'ok', false,
      'error', 'active_subscription',
      'message', 'Cancel your Trexpanda subscription first (Account > Manage billing), then delete your account.'
    );
  end if;

  delete from auth.users where id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

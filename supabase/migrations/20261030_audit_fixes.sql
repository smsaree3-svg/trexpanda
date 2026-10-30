-- ===========================================================================
-- 2026-10-30 audit fixes. Run AFTER 20261026b_audit_fixes.sql. Idempotent.
--
-- 1. delete_my_account() refused FOREVER for anyone who once opened checkout
--    and didn't pay: create-checkout-session writes a placeholder row
--    (status 'incomplete', no stripe_subscription_id) to remember the Stripe
--    customer, and that row matched the 'incomplete' refusal. Such users could
--    never delete their account in the app (App Store / Play requirement).
--    'incomplete' now only blocks while a real Stripe subscription exists.
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
      and not coalesce(s.cancel_at_period_end, false)
      and (s.status in ('active', 'trialing', 'past_due', 'unpaid')
           or (s.status = 'incomplete' and s.stripe_subscription_id is not null))
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

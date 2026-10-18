-- Row-level security regression tests for the 2026-10-17 hardening (F1-F4).
-- Loaded by run.sh after 00_supabase_stub.sql, schema.sql, 10_fixtures.sql,
-- billing.sql, the migration (twice), then schema.sql + billing.sql AGAIN, so the
-- rules must survive re-runs. Every check raises on failure. Synthetic users only.

-- F1: no bulk profile listing; narrow discovery only ---------------------------
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ee',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.profiles) <> 1 then
    raise exception 'F1 FAIL: bulk select returned % profiles (expected only own row)', (select count(*) from public.profiles);
  end if;
  if (select count(*) from public.search_profiles('a')) <> 0 then
    raise exception 'F1 FAIL: 1-character search returned rows';
  end if;
  if (select count(*) from public.search_profiles('al%')) <> 0 then
    raise exception 'F1 FAIL: LIKE wildcard was not treated literally';
  end if;
  if (select username from public.search_profiles('ali') limit 1) is distinct from 'alice.real' then
    raise exception 'F1 FAIL: 3-character prefix search did not find alice.real';
  end if;
  if (select username from public.find_profile('Bob.Real')) is distinct from 'bob.real' then
    raise exception 'F1 FAIL: exact, case-insensitive lookup did not find bob.real';
  end if;
  if (select count(*) from public.find_profile('mallory')) <> 0 then
    raise exception 'F1 FAIL: find_profile returned the caller';
  end if;
  raise notice 'F1 ok: own row only; search needs 3+ chars; exact lookup works';
end $$;
rollback;

-- F2: requests can only be created as pending ----------------------------------
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ee',true);
set local role authenticated;
do $$ begin
  begin
    insert into public.friendships(requester_id, addressee_id, status)
      values ('00000000-0000-0000-0000-0000000000ee','00000000-0000-0000-0000-00000000000a','accepted');
    raise exception 'F2 FAIL: a requester inserted an already-accepted friendship';
  exception when insufficient_privilege then null;
  end;
  raise notice 'F2 ok: forged accepted insert rejected';
end $$;
rollback;

-- Legitimate flow: request -> addressee accepts -> owner shares -> recipient reads -------
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',true);
set local role authenticated;
insert into public.friendships(requester_id, addressee_id)
  values ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b');
do $$ begin
  update public.friendships set status = 'accepted' where requester_id = auth.uid();
  if found then raise exception 'F2 FAIL: requester accepted their own request'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',true);
set local role authenticated;
do $$ begin
  update public.friendships set status = 'accepted' where addressee_id = auth.uid();
  if not found then raise exception 'FLOW FAIL: addressee could not accept'; end if;
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',true);
set local role authenticated;
insert into public.libraries(id, owner_id, name)
  values ('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-00000000000a','Team');
insert into public.library_shares(library_id, shared_with)
  values ('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-00000000000b');
do $$ begin
  begin
    insert into public.library_shares(library_id, shared_with)
      values ('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-0000000000ee');
    raise exception 'F2 FAIL: library shared with a non-friend';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.libraries) <> 1 then
    raise exception 'F4 FAIL: owner cannot read own library';
  end if;
  raise notice 'F2/F4 ok: share to friend allowed, to stranger rejected; no policy recursion';
end $$;
commit;

begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.libraries where name = 'Team') <> 1 then
    raise exception 'F4 FAIL: recipient cannot read the shared library';
  end if;
  if (select count(*) from public.profiles where username = 'alice.real') <> 1 then
    raise exception 'F1 FAIL: friend profile not visible';
  end if;
  raise notice 'F4 ok: recipient reads shared library and sees friend profile';
end $$;
rollback;

begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ee',true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.libraries) <> 0 then
    raise exception 'F4 FAIL: stranger can read a library';
  end if;
end $$;
rollback;

-- F3: holding the admin email grants nothing ---------------------------------
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ee',true);
set local role authenticated;
do $$ begin
  if public.is_admin() then raise exception 'F3 FAIL: email holder is admin'; end if;
  begin
    perform public.admin_list_users(10, 0);
    raise exception 'F3 FAIL: non-admin listed users';
  exception when insufficient_privilege then null;   -- 'Not authorized' (42501), as billing.sql raises it
  end;
  raise notice 'F3 ok: no email-based admin; admin RPCs refuse';
end $$;
rollback;


-- B1: usernames can't differ only by case; exact lookup wins -------------------
do $$ begin
  begin
    insert into auth.users(id, email, email_confirmed_at)
      values ('00000000-0000-0000-0000-0000000000ff','imp@example.test', now());
    insert into public.profiles(id, username) values ('00000000-0000-0000-0000-0000000000ff','ALICE.REAL');
    raise exception 'B1 FAIL: a case-variant username was accepted';
  exception when unique_violation then null;
  end;
  raise notice 'B1 ok: case-variant usernames rejected';
end $$;

-- S3: unfriending ends access to a shared library -----------------------------
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',true);
set local role authenticated;
delete from public.friendships where addressee_id = auth.uid() or requester_id = auth.uid();
do $$ begin
  if (select count(*) from public.libraries) <> 0 then
    raise exception 'S3 FAIL: ex-friend can still read the shared library';
  end if;
  if (select count(*) from public.profiles where username = 'alice.real') <> 0 then
    raise exception 'S3 FAIL: ex-friend can still read the profile';
  end if;
  raise notice 'S3 ok: unfriending ends library and profile access';
end $$;
rollback;

-- Anonymous callers get nothing -------------------------------------------------
begin;
set local role anon;
do $$ begin
  if (select count(*) from public.profiles) <> 0 then raise exception 'ANON FAIL: anon read profiles'; end if;
  begin
    perform * from public.search_profiles('ali');
    raise exception 'ANON FAIL: anon called search_profiles';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.find_profile('alice.real');
    raise exception 'ANON FAIL: anon called find_profile';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ANON ok: no profile rows and no RPC access for anon';
end $$;
rollback;

-- Nobody edits someone else's profile -----------------------------------------
begin;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000ee',true);
set local role authenticated;
do $$ begin
  update public.profiles set display_name = 'pwned' where username = 'alice.real';
  if found then raise exception 'PROFILE FAIL: edited another user''s profile'; end if;
  raise notice 'PROFILE ok: cannot edit other profiles';
end $$;
rollback;

select 'ALL RLS TESTS PASSED' as result;

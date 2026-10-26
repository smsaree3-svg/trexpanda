-- TEST-ONLY stand-in for Supabase internals. Never run against a real project.
-- Minimal stand-in for the parts of Supabase that schema.sql / billing.sql rely on.
-- Mirrors Supabase defaults: roles anon/authenticated, auth.uid() from the JWT
-- "sub" claim, and table privileges granted to both API roles (RLS does the gating).
create extension if not exists pgcrypto;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
-- Like Supabase: new functions are executable by the API roles unless revoked.
alter default privileges in schema public grant execute on functions to anon, authenticated;
create publication supabase_realtime;

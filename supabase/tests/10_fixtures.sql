-- Synthetic users, loaded BEFORE billing.sql so that any email-matched admin
-- seed in billing.sql would fire against the attacker-held address (F3).
insert into auth.users(id, email, email_confirmed_at) values
 ('00000000-0000-0000-0000-00000000000a','alice@example.test', now()),
 ('00000000-0000-0000-0000-00000000000b','bob@example.test',   now()),
 ('00000000-0000-0000-0000-0000000000ee','hello@trexpanda.com', now());  -- attacker-held admin address
insert into public.profiles(id, username, display_name) values
 ('00000000-0000-0000-0000-00000000000a','alice.real','Alice Example'),
 ('00000000-0000-0000-0000-00000000000b','bob.real','Bob Example'),
 ('00000000-0000-0000-0000-0000000000ee','mallory','Mallory');

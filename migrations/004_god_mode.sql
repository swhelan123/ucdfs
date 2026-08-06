-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: god mode
--
--  Two separate things, and keeping them separate is the whole point:
--
--    profiles.role = 'admin'   the CAPABILITY. Who is allowed to have god mode.
--                              Granted by a human, in SQL, deliberately.
--    profiles.god_mode         whether it is currently SWITCHED ON. Toggled by
--                              the admin themselves, from the app.
--
--  Why bother with the second one: an admin who is permanently elevated cannot
--  see what the team sees. Every "why can't I click that?" question becomes
--  unanswerable, and every accidental click lands on someone else's data. So
--  god mode is a switch you flip when you need it, and the app says loudly when
--  it is on.
--
--  Turning god mode OFF makes an admin behave as an ordinary member everywhere,
--  including the Competition Hub. Turning it back ON only ever needs role =
--  'admin', never god_mode itself, or an admin could switch themselves out of
--  their own admin rights and have no way back in short of this file.
--
--  Safe to run on the live database: one additive column and one UPDATE.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists god_mode boolean not null default false;

comment on column public.profiles.god_mode is
  'Is this admin currently elevated? Meaningless unless role = admin. The role is the capability, this is the switch.';


-- ── Grant it ───────────────────────────────────────────────────────────────
-- role is already 'admin' here from 001 PART 3; this just switches it on so
-- the app is usable as an admin immediately rather than after a hunt for the
-- toggle. Everyone else keeps the false default.
update public.profiles
   set role = 'admin', god_mode = true
 where lower(email) = lower('shane.whelan2@ucdconnect.ie');


-- ── Promoting the rest of the committee ────────────────────────────────────
-- Do this from /admin in the app now rather than here. It is a normal task,
-- not a migration. This is only the bootstrap for the first admin, who cannot
-- promote themselves through a UI they cannot yet reach.
--
--   update public.profiles set role = 'committee'
--    where lower(email) = lower('them@ucdconnect.ie');
--
-- Who has what:
--   select email, first_name, last_name, role, god_mode from public.profiles
--    order by role, email;

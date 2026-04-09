-- =============================================================
-- Seed data — run AFTER schema.sql
-- =============================================================

-- Locations (edit coordinates here any time)
insert into public.locations (id, label, x, y, is_home) values
  ('homebase',         'Home Base',        0, 0, true),
  ('engineers_office', 'Engineers Office', 0, 2, false),
  ('storage_base',     'Storage Base',     2, 1, false),
  ('marine_port',      'Marine Port',      3, 2, false),
  ('admin_office',     'Admin Office',     1, 1, false)
on conflict (id) do update
  set label = excluded.label,
      x = excluded.x,
      y = excluded.y,
      is_home = excluded.is_home;

-- Bot state singleton
insert into public.bot_state (id, status, current_x, current_y)
values (1, 'idle', 0, 0)
on conflict (id) do nothing;

-- =============================================================
-- HOW TO CREATE USERS:
-- Go to Supabase Dashboard > Authentication > Users > Add User
-- Use email + password.
-- After creating, run this to assign their location:
--
-- update public.profiles
--   set name = 'Alice', location_id = 'engineers_office'
--   where id = 'PASTE_USER_UUID_HERE';
--
-- update public.profiles
--   set name = 'Bob', location_id = 'admin_office'
--   where id = 'PASTE_USER_UUID_HERE';
-- =============================================================

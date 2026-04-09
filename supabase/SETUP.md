# Supabase Setup Guide

## Step 1 — Create project
Go to https://supabase.com, create a new project.

## Step 2 — Run schema
In your Supabase dashboard go to SQL Editor and paste + run:
  supabase/schema.sql   (run first)
  supabase/seed.sql     (run second)

## Step 3 — Create users
Go to Authentication > Users > Add User (with email + password).
Create one user per station operator (e.g. alice@lab.com, bob@lab.com).

After creating each user, run this in SQL Editor to assign their station:

  update public.profiles
    set name = 'Alice', location_id = 'engineers_office'
    where id = 'PASTE_UUID_FROM_AUTH_USERS_TABLE';

  update public.profiles
    set name = 'Bob', location_id = 'admin_office'
    where id = 'PASTE_UUID_FROM_AUTH_USERS_TABLE';

Repeat for each user. location_id must match an id in the locations table:
  homebase, engineers_office, storage_base, marine_port, admin_office

## Step 4 — Enable Realtime
Go to Database > Replication and enable realtime for:
  - deliveries
  - bot_state

## Step 5 — Get your keys
Settings > API:
  - Project URL  -> NEXT_PUBLIC_SUPABASE_URL
  - anon public  -> NEXT_PUBLIC_SUPABASE_ANON_KEY

## Changing location coordinates
Just run an update in SQL Editor:
  update public.locations set x = 4, y = 3 where id = 'marine_port';
No code changes needed — the grid map renders from the DB.

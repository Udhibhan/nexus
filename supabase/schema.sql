-- =============================================================
-- mbot Delivery System — Supabase Schema
-- Run this in the Supabase SQL editor (in order)
-- =============================================================

-- 1. Locations table (all grid coordinates — edit these any time)
create table if not exists public.locations (
  id          text primary key,          -- slug: 'homebase', 'engineers_office', etc.
  label       text        not null,      -- display name
  x           integer     not null,
  y           integer     not null,
  is_home     boolean     default false, -- only one should be true
  created_at  timestamptz default now()
);

alter table public.locations enable row level security;
create policy "Anyone can read locations" on public.locations for select using (true);
create policy "Auth users can update locations" on public.locations for update using (auth.role() = 'authenticated');

-- 2. Profiles (extends auth.users — one row per user)
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  name          text     not null,
  location_id   text     references public.locations(id),  -- which station this user sits at
  created_at    timestamptz default now()
);

alter table public.profiles enable row level security;
create policy "Users can read all profiles" on public.profiles for select using (auth.role() = 'authenticated');
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- 3. Deliveries (one row per delivery job)
create type delivery_status as enum (
  'idle',
  'going_pickup',
  'at_pickup',
  'loading',
  'in_transit',
  'at_delivery',
  'delivered',
  'returning'
);

create table if not exists public.deliveries (
  id                  uuid primary key default gen_random_uuid(),
  status              delivery_status  not null default 'idle',
  sender_id           uuid references public.profiles(id),
  recipient_id        uuid references public.profiles(id),
  pickup_location_id  text references public.locations(id),
  delivery_location_id text references public.locations(id),
  passcode            text,            -- plain text 4-digit code (short-lived, low risk)
  load_detected       boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

alter table public.deliveries enable row level security;

-- Sender sees their own deliveries
create policy "Sender sees own deliveries" on public.deliveries
  for select using (auth.uid() = sender_id);

-- Recipient sees deliveries addressed to them
create policy "Recipient sees own deliveries" on public.deliveries
  for select using (auth.uid() = recipient_id);

-- Authenticated users can insert/update
create policy "Auth users can insert" on public.deliveries
  for insert with check (auth.role() = 'authenticated');

create policy "Auth users can update" on public.deliveries
  for update using (auth.role() = 'authenticated');

-- 4. Bot state (singleton row — only ever 1 row)
create table if not exists public.bot_state (
  id            integer primary key default 1 check (id = 1),  -- enforces singleton
  status        text not null default 'idle',  -- mirrors delivery_status
  current_x     integer default 0,
  current_y     integer default 0,
  delivery_id   uuid references public.deliveries(id),
  updated_at    timestamptz default now()
);

alter table public.bot_state enable row level security;
create policy "Anyone auth can read bot state" on public.bot_state for select using (auth.role() = 'authenticated');
create policy "Anyone auth can update bot state" on public.bot_state for update using (auth.role() = 'authenticated');

-- 5. Auto-update updated_at on deliveries
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger deliveries_updated_at
  before update on public.deliveries
  for each row execute function update_updated_at();

create trigger bot_state_updated_at
  before update on public.bot_state
  for each row execute function update_updated_at();

-- 6. Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name, location_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'location_id'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- Sidefold Cloud Sync Schema for Supabase
-- Execute this in the SQL Editor of your Supabase project after creating it.

-- Enable the pgcrypto extension (for UUID generation if needed)
-- create extension if not exists "pgcrypto";

-- Create the user_data table
-- Stores categories, channel assignments, and settings per user per YouTube account
create table public.user_data (
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- YouTube channel ID. Must be canonical (UC + 22 url-safe base64 chars):
  -- the client validates this too, but a modified client could otherwise
  -- create unlimited junk rows with arbitrary account_ids.
  account_id text not null check (account_id ~ '^UC[0-9A-Za-z_-]{22}$'),
  categories jsonb not null default '{}',
  channel_assignments jsonb not null default '{}',
  settings   jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, account_id)
);

-- Enable Row Level Security
alter table public.user_data enable row level security;

-- RLS Policies: Users can only read/write their own data
create policy "Users can select their own data" on public.user_data
  for select using (auth.uid() = user_id);

create policy "Users can insert their own data" on public.user_data
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own data" on public.user_data
  for update using (auth.uid() = user_id);

create policy "Users can delete their own data" on public.user_data
  for delete using (auth.uid() = user_id);

-- Indexes for faster queries
create index idx_user_data_user_id on public.user_data(user_id);
create index idx_user_data_updated_at on public.user_data(updated_at);

-- ─── Upgrading an existing deployment ────────────────────────────────
-- If the table already exists (created with an earlier version of this
-- file), run only these statements in the SQL Editor instead:
--
-- alter table public.user_data
--   add constraint user_data_account_id_format
--   check (account_id ~ '^UC[0-9A-Za-z_-]{22}$') not valid;
-- alter table public.user_data validate constraint user_data_account_id_format;
--
-- create policy "Users can delete their own data" on public.user_data
--   for delete using (auth.uid() = user_id);

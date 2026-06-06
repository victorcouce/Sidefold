-- Sidefold Cloud Sync Schema for Supabase
-- Execute this in the SQL Editor of your Supabase project after creating it.

-- Enable the pgcrypto extension (for UUID generation if needed)
-- create extension if not exists "pgcrypto";

-- Create the user_data table
-- Stores categories, channel assignments, and settings per user per YouTube account
create table public.user_data (
  user_id    uuid not null references auth.users(id) on delete cascade,
  account_id text not null,                 -- YouTube channel ID (e.g., "UCxxxxxx")
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

-- (Note: DELETE policy is implicit via CASCADE on auth.users)

-- Indexes for faster queries
create index idx_user_data_user_id on public.user_data(user_id);
create index idx_user_data_updated_at on public.user_data(updated_at);

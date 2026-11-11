-- Run in the Supabase SQL Editor for the project used by CasaThomaz.
create table if not exists public.owner_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"properties":[],"contracts":[],"charges":[]}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  constraint owner_data_payload_shape check (
    jsonb_typeof(data) = 'object'
    and coalesce(jsonb_typeof(data -> 'properties') = 'array', false)
    and coalesce(jsonb_typeof(data -> 'contracts') = 'array', false)
    and coalesce(jsonb_typeof(data -> 'charges') = 'array', false)
  )
);

alter table public.owner_data enable row level security;
alter table public.owner_data force row level security;

revoke all on table public.owner_data from anon, authenticated;
grant select, insert, update on table public.owner_data to authenticated;

drop policy if exists "Owners can read their own portfolio" on public.owner_data;
create policy "Owners can read their own portfolio"
  on public.owner_data for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owners can create their own portfolio" on public.owner_data;
create policy "Owners can create their own portfolio"
  on public.owner_data for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Owners can update their own portfolio" on public.owner_data;
create policy "Owners can update their own portfolio"
  on public.owner_data for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

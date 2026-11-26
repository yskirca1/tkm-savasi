-- TKM Savaşı — initial schema. Run in Supabase SQL editor (or `supabase db push`).

-- Profiles: one per auth user. Email is NOT stored here (it lives in auth.users and never reaches clients).
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 3 and 20),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Case-insensitive uniqueness
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  total_rounds int not null check (total_rounds in (3,6,9,12)),
  started_at timestamptz not null,
  ended_at timestamptz not null default now()
);

create table if not exists public.match_results (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  rounds_won int not null default 0,
  is_winner boolean not null default false,
  -- false if a bot replaced the player after a disconnect (still counts as "played")
  finished_in_seat boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);
create index if not exists match_results_user_idx on public.match_results (user_id);

-- Aggregated stats (computed, never stored)
create or replace view public.profile_stats with (security_invoker = true) as
select p.id as user_id,
       count(r.match_id)::int                          as games_played,
       count(r.match_id) filter (where r.is_winner)::int as games_won,
       coalesce(sum(r.rounds_won), 0)::int             as rounds_won
from public.profiles p
left join public.match_results r on r.user_id = p.id
group by p.id;

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_results enable row level security;

-- Usernames/avatars are public to signed-in users
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select to authenticated using (true);
-- Only the owner may update their own profile
drop policy if exists "profiles own update" on public.profiles;
create policy "profiles own update" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "profiles own insert" on public.profiles;
create policy "profiles own insert" on public.profiles for insert to authenticated
  with check (auth.uid() = id);

-- Match data: readable by participants; written ONLY by the game server (service role bypasses RLS)
drop policy if exists "results own read" on public.match_results;
create policy "results own read" on public.match_results for select to authenticated using (auth.uid() = user_id);
drop policy if exists "matches participant read" on public.matches;
create policy "matches participant read" on public.matches for select to authenticated
  using (exists (select 1 from public.match_results r where r.match_id = id and r.user_id = auth.uid()));

-- Craft Family: Global XP + Flashcraft checkin sync
-- Run this in Supabase SQL Editor (Project: jkhboywafpdesmdguvts)

-- 0) Extensions (usually already enabled on Supabase)
create extension if not exists pgcrypto;

-- 1) Flashcraft daily checkins (source of "背诵次数")
create table if not exists public.flashcraft_checkins (
  user_id uuid not null references auth.users(id) on delete cascade,
  checkin_date date not null,
  cards int not null default 0,
  seconds int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, checkin_date)
);

alter table public.flashcraft_checkins enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'flashcraft_checkins_select_own') then
    create policy flashcraft_checkins_select_own
    on public.flashcraft_checkins
    for select
    using (user_id = auth.uid());
  end if;
end $$;

-- 2) XP ledger (append-only). Daily cap enforced by RPC.
create table if not exists public.craft_xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_date date not null,
  source text not null,
  event_type text not null,
  xp int not null check (xp >= 0),
  created_at timestamptz not null default now(),
  unique (user_id, event_date, source, event_type)
);

alter table public.craft_xp_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'craft_xp_events_select_own') then
    create policy craft_xp_events_select_own
    on public.craft_xp_events
    for select
    using (user_id = auth.uid());
  end if;
end $$;

-- 3) Level curve helpers
create or replace function public.craft_level_for_xp(xp_total int)
returns int
language plpgsql
immutable
as $$
declare
  lvl int := 1;
  remaining int := greatest(coalesce(xp_total, 0), 0);
  need int := 50; -- level 2 threshold increment
begin
  -- Curve: need = 50 + (lvl-1)*25 (grows slowly)
  while remaining >= need loop
    remaining := remaining - need;
    lvl := lvl + 1;
    need := 50 + (lvl - 1) * 25;
  end loop;
  return lvl;
end $$;

-- 4) Core XP award function (daily cap 50)
create or replace function public.craft_award_xp(
  p_event_date date,
  p_source text,
  p_event_type text,
  p_xp int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  today_xp int := 0;
  grant_xp int := 0;
  total_xp int := 0;
  lvl int := 1;
begin
  if uid is null then
    raise exception 'unauthorized';
  end if;

  -- Ensure profile row exists
  insert into public.profiles(id)
  values (uid)
  on conflict (id) do nothing;
  if p_xp is null or p_xp <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_xp');
  end if;
  if p_event_date is null then
    p_event_date := current_date;
  end if;
  if p_source is null or length(trim(p_source)) = 0 then
    p_source := 'unknown';
  end if;
  if p_event_type is null or length(trim(p_event_type)) = 0 then
    p_event_type := 'unknown';
  end if;

  select coalesce(sum(xp), 0)
    into today_xp
    from public.craft_xp_events
   where user_id = uid
     and event_date = p_event_date;

  grant_xp := least(p_xp, greatest(50 - today_xp, 0));
  if grant_xp <= 0 then
    return jsonb_build_object('ok', true, 'granted', 0, 'capped', true);
  end if;

  -- Idempotent insert: if already exists, award nothing.
  begin
    insert into public.craft_xp_events(user_id, event_date, source, event_type, xp)
    values (uid, p_event_date, p_source, p_event_type, grant_xp);
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'granted', 0, 'duplicate', true);
  end;

  update public.profiles
     set xp_total = coalesce(xp_total, 0) + grant_xp,
         level = public.craft_level_for_xp(coalesce(xp_total, 0) + grant_xp),
         updated_at = now()
   where id = uid
   returning xp_total, level into total_xp, lvl;

  return jsonb_build_object(
    'ok', true,
    'granted', grant_xp,
    'xp_total', total_xp,
    'level', lvl
  );
end $$;

-- 5) Flashcraft: record checkin + award XP (and acts as "背诵次数")
create or replace function public.flashcraft_record_checkin(
  p_checkin_date date,
  p_cards int,
  p_seconds int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  upserted boolean := false;
  xp_result jsonb;
begin
  if uid is null then
    raise exception 'unauthorized';
  end if;

  -- Ensure profile row exists
  insert into public.profiles(id)
  values (uid)
  on conflict (id) do nothing;
  if p_checkin_date is null then
    p_checkin_date := current_date;
  end if;

  insert into public.flashcraft_checkins(user_id, checkin_date, cards, seconds)
  values (uid, p_checkin_date, coalesce(p_cards, 0), coalesce(p_seconds, 0))
  on conflict (user_id, checkin_date)
  do update set
    cards = greatest(public.flashcraft_checkins.cards, excluded.cards),
    seconds = greatest(public.flashcraft_checkins.seconds, excluded.seconds)
  returning true into upserted;

  -- Award XP once per day (idempotent by unique constraint in craft_xp_events)
  xp_result := public.craft_award_xp(p_checkin_date, 'flashcraft', 'daily_checkin', 20);

  return jsonb_build_object(
    'ok', true,
    'checkin_saved', true,
    'xp', xp_result
  );
end $$;

-- Allow calling RPC from client
grant execute on function public.craft_award_xp(date, text, text, int) to anon, authenticated;
grant execute on function public.flashcraft_record_checkin(date, int, int) to anon, authenticated;

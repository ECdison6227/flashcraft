-- Shared quota tables + atomic counter for Edge Functions.

create table if not exists public.craft_ai_usage_day (
  day date not null,
  scope text not null,
  count integer not null default 0,
  primary key (day, scope)
);

create table if not exists public.craft_ai_usage_minute (
  minute bigint not null,
  scope text not null,
  count integer not null default 0,
  primary key (minute, scope)
);

alter table public.craft_ai_usage_day enable row level security;
alter table public.craft_ai_usage_minute enable row level security;

-- No policies: only service-role (Edge Function) should access these tables.

create or replace function public.craft_ai_try_consume(p_scope text, p_rpd integer, p_rpm integer)
returns table(ok boolean, retry_after integer, day_used integer, minute_used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now_utc timestamptz := (now() at time zone 'utc');
  v_day date := v_now_utc::date;
  v_minute bigint := floor(extract(epoch from v_now_utc) / 60);
  v_day_count integer;
  v_minute_count integer;
  v_retry integer := 0;
  v_next_midnight timestamptz := date_trunc('day', v_now_utc) + interval '1 day';
begin
  -- keep minute table small
  delete from public.craft_ai_usage_minute where minute < v_minute - 10;

  insert into public.craft_ai_usage_day(day, scope, count)
  values (v_day, p_scope, 0)
  on conflict (day, scope) do nothing;

  insert into public.craft_ai_usage_minute(minute, scope, count)
  values (v_minute, p_scope, 0)
  on conflict (minute, scope) do nothing;

  select count into v_day_count
  from public.craft_ai_usage_day
  where day = v_day and scope = p_scope
  for update;

  select count into v_minute_count
  from public.craft_ai_usage_minute
  where minute = v_minute and scope = p_scope
  for update;

  if p_rpd > 0 and v_day_count >= p_rpd then
    v_retry := greatest(60, (extract(epoch from (v_next_midnight - v_now_utc)))::int);
    return query select false, v_retry, v_day_count, v_minute_count;
    return;
  end if;

  if p_rpm > 0 and v_minute_count >= p_rpm then
    v_retry := greatest(1, 60 - ((extract(epoch from v_now_utc))::int % 60));
    return query select false, v_retry, v_day_count, v_minute_count;
    return;
  end if;

  update public.craft_ai_usage_day set count = count + 1 where day = v_day and scope = p_scope;
  update public.craft_ai_usage_minute set count = count + 1 where minute = v_minute and scope = p_scope;

  return query select true, 0, v_day_count + 1, v_minute_count + 1;
end;
$$;

create or replace function public.craft_ai_try_consume_pair(
  p_scope_a text, p_rpd_a integer, p_rpm_a integer,
  p_scope_b text, p_rpd_b integer, p_rpm_b integer
)
returns table(ok boolean, retry_after integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now_utc timestamptz := (now() at time zone 'utc');
  v_day date := v_now_utc::date;
  v_minute bigint := floor(extract(epoch from v_now_utc) / 60);
  v_next_midnight timestamptz := date_trunc('day', v_now_utc) + interval '1 day';
  v_day_a integer; v_day_b integer;
  v_min_a integer; v_min_b integer;
  v_retry integer := 0;
begin
  delete from public.craft_ai_usage_minute where minute < v_minute - 10;

  insert into public.craft_ai_usage_day(day, scope, count) values (v_day, p_scope_a, 0) on conflict (day, scope) do nothing;
  insert into public.craft_ai_usage_day(day, scope, count) values (v_day, p_scope_b, 0) on conflict (day, scope) do nothing;
  insert into public.craft_ai_usage_minute(minute, scope, count) values (v_minute, p_scope_a, 0) on conflict (minute, scope) do nothing;
  insert into public.craft_ai_usage_minute(minute, scope, count) values (v_minute, p_scope_b, 0) on conflict (minute, scope) do nothing;

  select count into v_day_a from public.craft_ai_usage_day where day = v_day and scope = p_scope_a for update;
  select count into v_day_b from public.craft_ai_usage_day where day = v_day and scope = p_scope_b for update;
  select count into v_min_a from public.craft_ai_usage_minute where minute = v_minute and scope = p_scope_a for update;
  select count into v_min_b from public.craft_ai_usage_minute where minute = v_minute and scope = p_scope_b for update;

  if p_rpd_a > 0 and v_day_a >= p_rpd_a then
    v_retry := greatest(v_retry, greatest(60, (extract(epoch from (v_next_midnight - v_now_utc)))::int));
  end if;
  if p_rpd_b > 0 and v_day_b >= p_rpd_b then
    v_retry := greatest(v_retry, greatest(60, (extract(epoch from (v_next_midnight - v_now_utc)))::int));
  end if;
  if p_rpm_a > 0 and v_min_a >= p_rpm_a then
    v_retry := greatest(v_retry, greatest(1, 60 - ((extract(epoch from v_now_utc))::int % 60)));
  end if;
  if p_rpm_b > 0 and v_min_b >= p_rpm_b then
    v_retry := greatest(v_retry, greatest(1, 60 - ((extract(epoch from v_now_utc))::int % 60)));
  end if;

  if v_retry > 0 then
    return query select false, v_retry;
    return;
  end if;

  update public.craft_ai_usage_day set count = count + 1 where day = v_day and scope in (p_scope_a, p_scope_b);
  update public.craft_ai_usage_minute set count = count + 1 where minute = v_minute and scope in (p_scope_a, p_scope_b);

  return query select true, 0;
end;
$$;

-- Limit direct access (Edge Function should call this via service role key)
revoke all on function public.craft_ai_try_consume(text, integer, integer) from public;
grant execute on function public.craft_ai_try_consume(text, integer, integer) to service_role;
revoke all on function public.craft_ai_try_consume_pair(text, integer, integer, text, integer, integer) from public;
grant execute on function public.craft_ai_try_consume_pair(text, integer, integer, text, integer, integer) to service_role;

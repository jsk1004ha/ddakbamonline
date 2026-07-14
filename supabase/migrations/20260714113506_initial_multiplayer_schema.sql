create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  games_played bigint not null default 0 check (games_played >= 0),
  games_won bigint not null default 0 check (games_won >= 0 and games_won <= games_played),
  hits_delivered bigint not null default 0 check (hits_delivered >= 0),
  hits_received bigint not null default 0 check (hits_received >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code) and code ~ '^[A-Z2-9]{6}$'),
  host_id uuid not null references public.profiles (id) on delete restrict,
  max_players smallint not null check (max_players between 2 and 4),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'showdown', 'closed')),
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.room_members (
  room_id uuid not null references public.game_rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  seat smallint not null check (seat between 0 and 3),
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (room_id, seat)
);

create table public.game_results (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.game_rooms (id) on delete set null,
  winner_id uuid references public.profiles (id) on delete set null,
  player_ids uuid[] not null check (cardinality(player_ids) between 2 and 4),
  stake bigint not null check (stake > 0),
  created_at timestamptz not null default now(),
  check (winner_id is null or winner_id = any (player_ids))
);

create table public.hit_obligations (
  id uuid primary key default gen_random_uuid(),
  game_result_id uuid not null references public.game_results (id) on delete restrict,
  room_id uuid references public.game_rooms (id) on delete set null,
  debtor_id uuid not null references public.profiles (id) on delete restrict,
  creditor_id uuid not null references public.profiles (id) on delete restrict,
  initial_hits bigint not null check (initial_hits > 0),
  remaining_hits bigint not null check (remaining_hits >= 0),
  delivered_hits bigint not null default 0 check (delivered_hits >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (debtor_id <> creditor_id),
  check (initial_hits = remaining_hits + delivered_hits)
);

create index game_rooms_status_code_idx on public.game_rooms (status, code);
create index room_members_user_id_idx on public.room_members (user_id);
create index game_results_player_ids_idx on public.game_results using gin (player_ids);
create index hit_obligations_debtor_idx on public.hit_obligations (debtor_id, remaining_hits);
create index hit_obligations_creditor_idx on public.hit_obligations (creditor_id, remaining_hits);

create or replace function private.is_room_member(target_room uuid, target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members
    where room_id = target_room and user_id = target_user
  );
$$;

create or replace function private.is_room_host(target_room uuid, target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_rooms
    where id = target_room and host_id = target_user
  );
$$;

create or replace function private.enforce_room_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed_players smallint;
  current_members integer;
begin
  if new.user_id <> auth.uid() then
    raise exception 'A user may only join as their own account';
  end if;

  select max_players
  into allowed_players
  from public.game_rooms
  where id = new.room_id and status = 'waiting'
  for update;

  if allowed_players is null then
    raise exception 'Room is not available';
  end if;

  select count(*) into current_members
  from public.room_members
  where room_id = new.room_id;

  if current_members >= allowed_players or new.seat >= allowed_players then
    raise exception 'Room is full';
  end if;

  return new;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
begin
  requested_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    split_part(coalesce(new.email, 'player'), '@', 1)
  );

  if char_length(requested_name) < 2 then
    requested_name := '플레이어';
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, left(requested_name, 24));
  return new;
end;
$$;

create or replace function private.record_game_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set games_played = games_played + 1
  where id = any (new.player_ids);

  if new.winner_id is not null then
    update public.profiles
    set games_won = games_won + 1
    where id = new.winner_id;
  end if;

  return new;
end;
$$;

create or replace function private.record_hit_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivered_delta bigint;
begin
  delivered_delta := new.delivered_hits - old.delivered_hits;
  if delivered_delta < 0 then
    raise exception 'Delivered hit count cannot decrease';
  end if;

  if delivered_delta > 0 then
    update public.profiles
    set hits_delivered = hits_delivered + delivered_delta
    where id = new.debtor_id;

    update public.profiles
    set hits_received = hits_received + delivered_delta
    where id = new.creditor_id;
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create trigger room_capacity_before_insert
before insert on public.room_members
for each row execute function private.enforce_room_capacity();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger game_rooms_set_updated_at
before update on public.game_rooms
for each row execute function public.set_updated_at();

create trigger hit_obligations_set_updated_at
before update on public.hit_obligations
for each row execute function public.set_updated_at();

create trigger game_results_record_stats
after insert on public.game_results
for each row execute function private.record_game_stats();

create trigger hit_obligations_record_stats
after update of delivered_hits on public.hit_obligations
for each row execute function private.record_hit_stats();

alter table public.profiles enable row level security;
alter table public.game_rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.game_results enable row level security;
alter table public.hit_obligations enable row level security;

create policy "Authenticated users can read player profiles"
on public.profiles for select
to authenticated
using (true);

create policy "Users can insert their own profile"
on public.profiles for insert
to authenticated
with check ((select auth.uid()) = id);

create policy "Users can update their own profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Authenticated users can find waiting rooms or their rooms"
on public.game_rooms for select
to authenticated
using (status = 'waiting' or private.is_room_member(id));

create policy "Users can create rooms they host"
on public.game_rooms for insert
to authenticated
with check ((select auth.uid()) = host_id);

create policy "Room members can update game state"
on public.game_rooms for update
to authenticated
using (private.is_room_member(id))
with check (private.is_room_member(id));

create policy "Room hosts can delete rooms"
on public.game_rooms for delete
to authenticated
using (private.is_room_host(id));

create policy "Users can read members of waiting or joined rooms"
on public.room_members for select
to authenticated
using (
  private.is_room_member(room_id)
  or exists (
    select 1 from public.game_rooms
    where id = room_id and status = 'waiting'
  )
);

create policy "Users can join waiting rooms as themselves"
on public.room_members for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.game_rooms
    where id = room_id and status = 'waiting'
  )
);

create policy "Users can update their own ready state"
on public.room_members for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can leave and hosts can remove room members"
on public.room_members for delete
to authenticated
using ((select auth.uid()) = user_id or private.is_room_host(room_id));

create policy "Players can read their game results"
on public.game_results for select
to authenticated
using ((select auth.uid()) = any (player_ids));

create policy "Room members can record their game results"
on public.game_results for insert
to authenticated
with check (
  (select auth.uid()) = any (player_ids)
  and (winner_id is null or (select auth.uid()) = winner_id)
  and (room_id is null or private.is_room_member(room_id))
);

create policy "Obligation parties can read their account ledger"
on public.hit_obligations for select
to authenticated
using ((select auth.uid()) = debtor_id or (select auth.uid()) = creditor_id);

create policy "Winning accounts can create directed obligations"
on public.hit_obligations for insert
to authenticated
with check (
  (select auth.uid()) = creditor_id
  and exists (
    select 1
    from public.game_results
    where id = game_result_id
      and winner_id = creditor_id
      and debtor_id = any (player_ids)
      and creditor_id = any (player_ids)
  )
  and (room_id is null or (private.is_room_member(room_id) and private.is_room_member(room_id, debtor_id)))
);

create policy "Creditor accounts can record delivered hits"
on public.hit_obligations for update
to authenticated
using ((select auth.uid()) = creditor_id)
with check ((select auth.uid()) = creditor_id);

grant usage on schema public to authenticated;
grant select, insert on public.profiles to authenticated;
grant update (display_name, updated_at) on public.profiles to authenticated;
grant select, insert, delete on public.game_rooms to authenticated;
grant update (status, state, updated_at) on public.game_rooms to authenticated;
grant select, insert, delete on public.room_members to authenticated;
grant update (ready) on public.room_members to authenticated;
grant select, insert on public.game_results to authenticated;
grant select, insert on public.hit_obligations to authenticated;
grant update (remaining_hits, delivered_hits, updated_at) on public.hit_obligations to authenticated;

grant usage on schema private to authenticated;
revoke all on function private.is_room_member(uuid, uuid) from public;
revoke all on function private.is_room_host(uuid, uuid) from public;
revoke all on function private.enforce_room_capacity() from public;
revoke all on function private.record_game_stats() from public;
revoke all on function private.record_hit_stats() from public;
grant execute on function private.is_room_member(uuid, uuid) to authenticated;
grant execute on function private.is_room_host(uuid, uuid) to authenticated;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

alter table public.game_rooms replica identity full;
alter table public.room_members replica identity full;
alter table public.hit_obligations replica identity full;

alter publication supabase_realtime add table public.game_rooms;
alter publication supabase_realtime add table public.room_members;
alter publication supabase_realtime add table public.hit_obligations;

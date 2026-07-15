-- Account IDs are the only supported public identity. Supabase Auth keeps the
-- synthetic email as an implementation detail at the authentication boundary.
alter table public.profiles
  add column account_id text;

update public.profiles as profile
set account_id = split_part(lower(auth_user.email), '@', 1)
from auth.users as auth_user
where auth_user.id = profile.id
  and lower(auth_user.email) ~ '^[a-z0-9_]{4,20}@accounts\.ddakbam\.invalid$';

do $$
begin
  if exists (select 1 from public.profiles where account_id is null) then
    raise exception 'Every profile must use an internal account ID identity';
  end if;
end;
$$;

alter table public.profiles
  alter column account_id set not null,
  add constraint profiles_account_id_format_check
    check (account_id ~ '^[a-z0-9_]{4,20}$'),
  add constraint profiles_account_id_key unique (account_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
  requested_account_id text;
begin
  if new.email is null
    or lower(new.email) !~ '^[a-z0-9_]{4,20}@accounts\.ddakbam\.invalid$'
  then
    raise exception 'Unsupported account identity';
  end if;

  requested_account_id := split_part(lower(new.email), '@', 1);
  requested_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    requested_account_id
  );
  if char_length(requested_name) < 2 then
    requested_name := '플레이어';
  end if;

  insert into public.profiles (id, account_id, display_name)
  values (new.id, requested_account_id, left(requested_name, 24));
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create table public.game_round_hands (
  room_id uuid not null references public.game_rooms (id) on delete cascade,
  round_token uuid not null,
  player_id uuid not null references public.profiles (id) on delete restrict,
  card_ids smallint[] not null,
  created_at timestamptz not null default now(),
  primary key (room_id, round_token, player_id),
  constraint game_round_hands_two_distinct_cards_check check (
    cardinality(card_ids) = 2
    and card_ids[1] between 1 and 20
    and card_ids[2] between 1 and 20
    and card_ids[1] <> card_ids[2]
  )
);

create table public.game_actions (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.game_rooms (id) on delete cascade,
  round_token uuid not null,
  player_id uuid not null references public.profiles (id) on delete restrict,
  room_version bigint not null check (room_version > 0),
  action_name text not null check (action_name in ('call', 'raise')),
  raise_to numeric,
  created_at timestamptz not null default now(),
  unique (room_id, round_token, room_version),
  constraint game_actions_raise_shape_check check (
    (action_name = 'call' and raise_to is null)
    or (
      action_name = 'raise'
      and raise_to > 0
      and raise_to = trunc(raise_to)
    )
  )
);

create index game_round_hands_player_id_idx
  on public.game_round_hands (player_id, room_id, round_token);
create index game_actions_room_round_idx
  on public.game_actions (room_id, round_token, id);
create index game_actions_player_id_idx
  on public.game_actions (player_id, created_at desc);

alter table public.game_round_hands enable row level security;
alter table public.game_actions enable row level security;

create policy "Players see own hand until current showdown"
on public.game_round_hands for select
to authenticated
using (
  player_id = (select auth.uid())
  or (
    private.is_room_member(room_id)
    and exists (
      select 1
      from public.game_rooms as room
      where room.id = game_round_hands.room_id
        and room.state ->> 'roundToken' = game_round_hands.round_token::text
        and room.state ->> 'phase' = 'showdown'
    )
  )
);

create policy "Room members can read the action log"
on public.game_actions for select
to authenticated
using (private.is_room_member(room_id));

revoke all on public.game_round_hands from public, anon, authenticated;
revoke all on public.game_actions from public, anon, authenticated;
grant select on public.game_round_hands to authenticated;
grant select on public.game_actions to authenticated;

-- The previous browser-authoritative policies are removed before the new RPC
-- entry points are granted. Waiting-room create/join/ready operations remain.
drop policy if exists "Room members can update synchronized game state"
  on public.game_rooms;
drop policy if exists "Room members can record their game results"
  on public.game_results;
drop policy if exists "Winning accounts can create directed obligations"
  on public.hit_obligations;
drop policy if exists "Creditor accounts can record delivered hits"
  on public.hit_obligations;

drop policy if exists "Users can leave and hosts can remove room members"
  on public.room_members;
create policy "Users can leave and hosts can remove waiting-room members"
on public.room_members for delete
to authenticated
using (
  ((select auth.uid()) = user_id or private.is_room_host(room_id))
  and exists (
    select 1
    from public.game_rooms as room
    where room.id = room_members.room_id
      and room.status = 'waiting'
  )
);

drop policy if exists "Room hosts can delete rooms" on public.game_rooms;
create policy "Room hosts can delete waiting rooms"
on public.game_rooms for delete
to authenticated
using (
  private.is_room_host(id)
  and status = 'waiting'
);

drop trigger if exists game_rooms_restrict_status_changes
  on public.game_rooms;
drop function if exists private.restrict_room_status_changes();

revoke update (status, state, version, updated_at)
  on public.game_rooms from authenticated;
revoke insert on public.game_rooms from authenticated;
grant insert (code, host_id, max_players)
  on public.game_rooms to authenticated;
revoke insert on public.game_results from authenticated;
revoke insert, update on public.hit_obligations from authenticated;

create or replace function private.ordered_room_players(target_room uuid)
returns table (player_id uuid, seat smallint)
language sql
stable
security definer
set search_path = ''
as $$
  select member.user_id, member.seat
  from public.room_members as member
  where member.room_id = target_room
  order by member.seat;
$$;

create or replace function private.parse_exact_nonnegative_integer(
  input_value text,
  allow_zero boolean default true
)
returns numeric
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  parsed_value numeric;
begin
  if input_value is null or input_value !~ '^(0|[1-9][0-9]*)$' then
    raise exception 'Expected a canonical unsigned decimal integer';
  end if;
  parsed_value := input_value::numeric;
  if (allow_zero and parsed_value < 0)
    or (not allow_zero and parsed_value <= 0)
  then
    raise exception 'Expected a % integer',
      case when allow_zero then 'nonnegative' else 'positive' end;
  end if;
  return parsed_value;
end;
$$;

create or replace function private.serialize_exact_integer(input_value numeric)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if input_value < 0 or input_value <> trunc(input_value) then
    raise exception 'Cannot serialize a negative or fractional quantity';
  end if;
  if input_value <= 9007199254740991 then
    return to_jsonb(input_value::bigint);
  end if;
  return to_jsonb(input_value::text);
end;
$$;

create or replace function private.evaluate_seotda_hand(input_card_ids smallint[])
returns table (
  name text,
  rank integer,
  tiebreak integer,
  months smallint[]
)
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  first_month smallint;
  second_month smallint;
  month_key text;
  both_bright boolean;
  points integer;
begin
  if cardinality(input_card_ids) <> 2
    or input_card_ids[1] not between 1 and 20
    or input_card_ids[2] not between 1 and 20
    or input_card_ids[1] = input_card_ids[2]
  then
    raise exception 'A hand must contain two distinct deck cards';
  end if;

  first_month := ((input_card_ids[1] - 1) / 2 + 1)::smallint;
  second_month := ((input_card_ids[2] - 1) / 2 + 1)::smallint;
  if first_month > second_month then
    months := array[second_month, first_month]::smallint[];
  else
    months := array[first_month, second_month]::smallint[];
  end if;
  month_key := months[1]::text || ',' || months[2]::text;
  both_bright := input_card_ids[1] = any (array[1, 5, 15]::smallint[])
    and input_card_ids[2] = any (array[1, 5, 15]::smallint[]);

  if both_bright and month_key = '3,8' then
    name := '38광땡'; rank := 3; tiebreak := 3;
  elsif both_bright and month_key = '1,8' then
    name := '18광땡'; rank := 3; tiebreak := 2;
  elsif both_bright and month_key = '1,3' then
    name := '13광땡'; rank := 3; tiebreak := 1;
  elsif months[1] = months[2] then
    name := months[1]::text || '땡'; rank := 2; tiebreak := months[1];
  elsif month_key = '1,2' then
    name := '알리'; rank := 1; tiebreak := 6;
  elsif month_key = '1,4' then
    name := '독사'; rank := 1; tiebreak := 5;
  elsif month_key = '1,9' then
    name := '구삥'; rank := 1; tiebreak := 4;
  elsif month_key = '1,10' then
    name := '장삥'; rank := 1; tiebreak := 3;
  elsif month_key = '4,10' then
    name := '장사'; rank := 1; tiebreak := 2;
  elsif month_key = '4,6' then
    name := '세륙'; rank := 1; tiebreak := 1;
  else
    points := (months[1] + months[2]) % 10;
    name := case
      when points = 9 then '갑오'
      when points = 0 then '망통'
      else points::text || '끗'
    end;
    rank := 0;
    tiebreak := points;
  end if;
  return next;
end;
$$;

create or replace function private.build_public_round_state(
  input_round_token uuid,
  input_round_number bigint,
  input_player_ids uuid[],
  input_commitments jsonb,
  input_current_stake numeric,
  input_pot numeric,
  input_turn_player_id uuid,
  input_last_aggressor_id uuid,
  input_betting_status text,
  input_pending_player_ids uuid[],
  input_phase text,
  input_evaluations jsonb,
  input_winner_ids uuid[]
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema', 2,
    'roundToken', input_round_token,
    'roundNumber', input_round_number,
    'playerIds', to_jsonb(input_player_ids),
    'betting', jsonb_build_object(
      'playerIds', to_jsonb(input_player_ids),
      'commitments', input_commitments,
      'currentStake', private.serialize_exact_integer(input_current_stake),
      'pot', private.serialize_exact_integer(input_pot),
      'turnPlayerId', to_jsonb(input_turn_player_id),
      'lastAggressorId', to_jsonb(input_last_aggressor_id),
      'status', input_betting_status,
      'pendingPlayerIds', to_jsonb(input_pending_player_ids)
    ),
    'phase', input_phase,
    'evaluations', input_evaluations,
    'winnerIds', to_jsonb(input_winner_ids)
  );
$$;

revoke all on all functions in schema private from public;
revoke all on function private.ordered_room_players(uuid) from anon, authenticated;
revoke all on function private.parse_exact_nonnegative_integer(text, boolean)
  from anon, authenticated;
revoke all on function private.serialize_exact_integer(numeric)
  from anon, authenticated;
revoke all on function private.evaluate_seotda_hand(smallint[])
  from anon, authenticated;
revoke all on function private.build_public_round_state(
  uuid, bigint, uuid[], jsonb, numeric, numeric, uuid, uuid, text, uuid[], text, jsonb, uuid[]
) from anon, authenticated;

create or replace function public.start_game_round(
  target_room uuid,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
  player_ids uuid[];
  shuffled_deck integer[];
  player_count integer;
  ready_count integer;
  player_index integer;
  next_round_number bigint;
  next_round_token uuid := gen_random_uuid();
  commitments jsonb;
  next_state jsonb;
  first_round boolean;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;
  if expected_version is null or expected_version < 0 then
    raise exception 'Expected version must be nonnegative';
  end if;

  select room.*
  into room_record
  from public.game_rooms as room
  where room.id = target_room
  for update;

  if not found then
    raise exception 'Room not found';
  end if;
  if room_record.host_id <> caller_id then
    raise exception 'Only the room host may start a round';
  end if;
  if room_record.version <> expected_version then
    raise exception 'Stale room version';
  end if;

  -- private.enforce_room_capacity() serializes joins with this start lock by
  -- selecting the same game_rooms row where status = 'waiting' for update.
  select array_agg(ordered.player_id order by ordered.seat)
  into player_ids
  from private.ordered_room_players(target_room) as ordered;
  player_count := coalesce(cardinality(player_ids), 0);
  if player_count < 2 or player_count > 4 then
    raise exception 'A round requires two to four players';
  end if;
  if not (caller_id = any (player_ids)) then
    raise exception 'The room host must occupy a player seat';
  end if;

  first_round := coalesce(room_record.state ->> 'schema', '') <> '2';
  if first_round then
    if room_record.status <> 'waiting' then
      raise exception 'The first round must start from a waiting room';
    end if;
    select count(*)
    into ready_count
    from public.room_members as member
    where member.room_id = target_room
      and member.ready;
    if ready_count <> player_count then
      raise exception 'Every player must be ready';
    end if;
    next_round_number := 1;
  else
    if room_record.status <> 'playing'
      or room_record.state ->> 'phase' <> 'showdown'
    then
      raise exception 'The current round is not ready to advance';
    end if;
    next_round_number := private.parse_exact_nonnegative_integer(
      room_record.state ->> 'roundNumber',
      false
    )::bigint + 1;
  end if;

  select array_agg(deck_card order by gen_random_uuid())
  into shuffled_deck
  from generate_series(1, 20) as deck_card;

  for player_index in 1..player_count loop
    insert into public.game_round_hands (
      room_id,
      round_token,
      player_id,
      card_ids
    )
    values (
      target_room,
      next_round_token,
      player_ids[player_index],
      array[
        shuffled_deck[player_index]::smallint,
        shuffled_deck[player_count + player_index]::smallint
      ]::smallint[]
    );
  end loop;

  select jsonb_object_agg(player_id::text, to_jsonb(0))
  into commitments
  from unnest(player_ids) as player_id;

  next_state := private.build_public_round_state(
    next_round_token,
    next_round_number,
    player_ids,
    commitments,
    1,
    0,
    player_ids[1],
    null,
    'betting',
    player_ids,
    'betting',
    '{}'::jsonb,
    array[]::uuid[]
  );

  update public.game_rooms
  set
    status = 'playing',
    state = next_state,
    version = room_record.version + 1
  where id = target_room;

  return jsonb_build_object(
    'state', next_state,
    'version', room_record.version + 1
  );
end;
$$;

create or replace function public.play_game_action(
  target_room uuid,
  expected_version bigint,
  action_name text,
  raise_to text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
  state_record jsonb;
  betting_record jsonb;
  current_round_token uuid;
  round_number bigint;
  player_ids uuid[];
  ordered_member_ids uuid[];
  pending_player_ids uuid[];
  next_pending_player_ids uuid[] := array[]::uuid[];
  player_count integer;
  actor_index integer;
  offset_index integer;
  candidate_id uuid;
  commitments jsonb;
  current_stake numeric;
  next_stake numeric;
  current_pot numeric;
  current_commitment numeric;
  commitment_value numeric;
  commitment_total numeric := 0;
  next_pot numeric;
  next_turn_player_id uuid;
  last_aggressor_id uuid;
  betting_status text := 'betting';
  next_phase text := 'betting';
  evaluations jsonb := '{}'::jsonb;
  winner_ids uuid[] := array[]::uuid[];
  best_rank integer := -1;
  best_tiebreak integer := -1;
  hand_cards smallint[];
  hand_name text;
  hand_rank integer;
  hand_tiebreak integer;
  hand_months smallint[];
  next_state jsonb;
  result_id uuid;
  existing_result public.game_results%rowtype;
  sole_winner_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;
  if expected_version is null or expected_version < 0 then
    raise exception 'Expected version must be nonnegative';
  end if;
  if action_name not in ('call', 'raise') then
    raise exception 'Action must be call or raise';
  end if;

  select room.*
  into room_record
  from public.game_rooms as room
  where room.id = target_room
  for update;

  if not found then
    raise exception 'Room not found';
  end if;
  if room_record.version <> expected_version then
    raise exception 'Stale room version';
  end if;
  if room_record.status <> 'playing'
    or not private.is_room_member(target_room, caller_id)
  then
    raise exception 'Caller is not an active room member';
  end if;

  state_record := room_record.state;
  if state_record ->> 'schema' <> '2'
    or state_record ->> 'phase' <> 'betting'
    or state_record ? 'hands'
    or jsonb_typeof(state_record -> 'playerIds') <> 'array'
    or jsonb_typeof(state_record -> 'betting') <> 'object'
  then
    raise exception 'Room state is not an active server round';
  end if;

  current_round_token := (state_record ->> 'roundToken')::uuid;
  round_number := private.parse_exact_nonnegative_integer(
    state_record ->> 'roundNumber',
    false
  )::bigint;
  select array_agg(value::uuid order by ordinal)
  into player_ids
  from jsonb_array_elements_text(state_record -> 'playerIds')
    with ordinality as listed(value, ordinal);
  player_count := coalesce(cardinality(player_ids), 0);
  if player_count < 2
    or player_count > 4
    or cardinality(array(
      select distinct listed_player_id
      from unnest(player_ids) as listed_player_id
    )) <> player_count
    or not (caller_id = any (player_ids))
  then
    raise exception 'Round player list is invalid';
  end if;

  select array_agg(ordered.player_id order by ordered.seat)
  into ordered_member_ids
  from private.ordered_room_players(target_room) as ordered;
  if ordered_member_ids is distinct from player_ids then
    raise exception 'Round players no longer match room membership';
  end if;

  betting_record := state_record -> 'betting';
  if betting_record ->> 'status' <> 'betting'
    or jsonb_typeof(betting_record -> 'playerIds') <> 'array'
    or betting_record -> 'playerIds' <> state_record -> 'playerIds'
    or jsonb_typeof(betting_record -> 'commitments') <> 'object'
    or jsonb_typeof(betting_record -> 'pendingPlayerIds') <> 'array'
  then
    raise exception 'Betting state is invalid';
  end if;

  commitments := betting_record -> 'commitments';
  if (select count(*) from jsonb_object_keys(commitments)) <> player_count
    or exists (
      select 1
      from jsonb_object_keys(commitments) as key
      where not (key::uuid = any (player_ids))
    )
  then
    raise exception 'Commitment keys do not match round players';
  end if;

  current_stake := private.parse_exact_nonnegative_integer(
    betting_record ->> 'currentStake',
    false
  );
  current_pot := private.parse_exact_nonnegative_integer(
    betting_record ->> 'pot',
    true
  );
  foreach candidate_id in array player_ids loop
    commitment_value := private.parse_exact_nonnegative_integer(
      commitments ->> candidate_id::text,
      true
    );
    if commitment_value > current_stake then
      raise exception 'A commitment exceeds the current stake';
    end if;
    commitment_total := commitment_total + commitment_value;
  end loop;
  if commitment_total <> current_pot then
    raise exception 'Pot does not equal commitments';
  end if;

  select coalesce(array_agg(value::uuid order by ordinal), array[]::uuid[])
  into pending_player_ids
  from jsonb_array_elements_text(betting_record -> 'pendingPlayerIds')
    with ordinality as listed(value, ordinal);
  if cardinality(pending_player_ids) = 0
    or pending_player_ids[1] <> caller_id
    or cardinality(array(
      select distinct pending_player_id
      from unnest(pending_player_ids) as pending_player_id
    ))
      <> cardinality(pending_player_ids)
    or exists (
      select 1 from unnest(pending_player_ids) as pending_id
      where not (pending_id = any (player_ids))
    )
    or (betting_record ->> 'turnPlayerId')::uuid <> caller_id
  then
    raise exception 'Only the current turn player may act';
  end if;

  foreach candidate_id in array player_ids loop
    commitment_value := private.parse_exact_nonnegative_integer(
      commitments ->> candidate_id::text,
      true
    );
    if ((candidate_id = any (pending_player_ids)) and commitment_value >= current_stake)
      or ((not candidate_id = any (pending_player_ids)) and commitment_value <> current_stake)
    then
      raise exception 'Pending players do not match commitments';
    end if;
  end loop;

  last_aggressor_id := nullif(betting_record ->> 'lastAggressorId', '')::uuid;
  if last_aggressor_id is not null
    and (
      not (last_aggressor_id = any (player_ids))
      or last_aggressor_id = any (pending_player_ids)
      or private.parse_exact_nonnegative_integer(
        commitments ->> last_aggressor_id::text,
        true
      ) <> current_stake
    )
  then
    raise exception 'Last aggressor is inconsistent';
  end if;

  current_commitment := private.parse_exact_nonnegative_integer(
    commitments ->> caller_id::text,
    true
  );

  if action_name = 'raise' then
    if raise_to is null then
      raise exception 'Raise amount is required';
    end if;
    next_stake := private.parse_exact_nonnegative_integer(raise_to, false);
    if next_stake <= current_stake then
      raise exception 'raise_to must exceed current_stake';
    end if;
    commitments := jsonb_set(
      commitments,
      array[caller_id::text],
      private.serialize_exact_integer(next_stake),
      false
    );
    next_pot := current_pot + next_stake - current_commitment;
    actor_index := array_position(player_ids, caller_id);
    for offset_index in 1..(player_count - 1) loop
      candidate_id := player_ids[
        ((actor_index - 1 + offset_index) % player_count) + 1
      ];
      next_pending_player_ids := array_append(
        next_pending_player_ids,
        candidate_id
      );
    end loop;
    next_turn_player_id := next_pending_player_ids[1];
    last_aggressor_id := caller_id;
  else
    if raise_to is not null then
      raise exception 'Call cannot include a raise amount';
    end if;
    next_stake := current_stake;
    commitments := jsonb_set(
      commitments,
      array[caller_id::text],
      private.serialize_exact_integer(current_stake),
      false
    );
    next_pot := current_pot + current_stake - current_commitment;
    if cardinality(pending_player_ids) > 1 then
      next_pending_player_ids := pending_player_ids[
        2:cardinality(pending_player_ids)
      ];
    end if;

    if cardinality(next_pending_player_ids) = 0 then
      foreach candidate_id in array player_ids loop
        if private.parse_exact_nonnegative_integer(
          commitments ->> candidate_id::text,
          true
        ) <> current_stake then
          raise exception 'Betting cannot complete before all commitments match';
        end if;
      end loop;
      betting_status := 'complete';
      next_phase := 'showdown';
      next_turn_player_id := null;
    else
      next_turn_player_id := next_pending_player_ids[1];
    end if;
  end if;

  if next_phase = 'showdown' then
    foreach candidate_id in array player_ids loop
      select hand.card_ids
      into hand_cards
      from public.game_round_hands as hand
      where hand.room_id = target_room
        and hand.round_token = current_round_token
        and hand.player_id = candidate_id;
      if not found then
        raise exception 'Protected round hand is missing';
      end if;

      select evaluated.name, evaluated.rank, evaluated.tiebreak, evaluated.months
      into hand_name, hand_rank, hand_tiebreak, hand_months
      from private.evaluate_seotda_hand(hand_cards) as evaluated;

      evaluations := evaluations || jsonb_build_object(
        candidate_id::text,
        jsonb_build_object(
          'name', hand_name,
          'rank', hand_rank,
          'tiebreak', hand_tiebreak,
          'months', to_jsonb(hand_months)
        )
      );
      if hand_rank > best_rank
        or (hand_rank = best_rank and hand_tiebreak > best_tiebreak)
      then
        best_rank := hand_rank;
        best_tiebreak := hand_tiebreak;
      end if;
    end loop;

    foreach candidate_id in array player_ids loop
      if (evaluations -> candidate_id::text ->> 'rank')::integer = best_rank
        and (evaluations -> candidate_id::text ->> 'tiebreak')::integer = best_tiebreak
      then
        winner_ids := array_append(winner_ids, candidate_id);
      end if;
    end loop;
    if cardinality(winner_ids) = 1 then
      sole_winner_id := winner_ids[1];
    end if;

    insert into public.game_results (
      room_id,
      round_token,
      winner_id,
      player_ids,
      stake
    )
    values (
      target_room,
      current_round_token,
      sole_winner_id,
      player_ids,
      current_stake
    )
    on conflict (round_token) do nothing
    returning id into result_id;

    if result_id is null then
      select result.*
      into existing_result
      from public.game_results as result
      where result.round_token = current_round_token;
      if not found
        or existing_result.room_id is distinct from target_room
        or existing_result.player_ids is distinct from player_ids
        or existing_result.winner_id is distinct from sole_winner_id
        or existing_result.stake is distinct from current_stake
      then
        raise exception 'Round token already has a different settlement';
      end if;
      result_id := existing_result.id;
    end if;

    if sole_winner_id is not null then
      foreach candidate_id in array player_ids loop
        if candidate_id <> sole_winner_id then
          insert into public.hit_obligations (
            game_result_id,
            room_id,
            debtor_id,
            creditor_id,
            initial_hits,
            remaining_hits,
            delivered_hits
          )
          values (
            result_id,
            target_room,
            candidate_id,
            sole_winner_id,
            current_stake,
            current_stake,
            0
          )
          on conflict (game_result_id, debtor_id, creditor_id) do nothing;
        end if;
      end loop;
    end if;
  end if;

  next_state := private.build_public_round_state(
    current_round_token,
    round_number,
    player_ids,
    commitments,
    next_stake,
    next_pot,
    next_turn_player_id,
    last_aggressor_id,
    betting_status,
    next_pending_player_ids,
    next_phase,
    evaluations,
    winner_ids
  );

  insert into public.game_actions (
    room_id,
    round_token,
    player_id,
    room_version,
    action_name,
    raise_to
  )
  values (
    target_room,
    current_round_token,
    caller_id,
    room_record.version + 1,
    action_name,
    case when action_name = 'raise' then next_stake else null end
  );

  update public.game_rooms
  set
    state = next_state,
    version = room_record.version + 1
  where id = target_room;

  return jsonb_build_object(
    'state', next_state,
    'version', room_record.version + 1
  );
end;
$$;

create or replace function public.record_physical_hit(
  obligation_id uuid,
  expected_remaining numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  obligation_record public.hit_obligations%rowtype;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;
  if expected_remaining is null
    or expected_remaining <= 0
    or expected_remaining <> trunc(expected_remaining)
  then
    raise exception 'Expected remaining hits must be a positive integer';
  end if;

  select obligation.*
  into obligation_record
  from public.hit_obligations as obligation
  where obligation.id = obligation_id
  for update;

  if not found then
    raise exception 'Hit obligation not found';
  end if;
  if obligation_record.creditor_id <> caller_id then
    raise exception 'Only the creditor may record the physical hit';
  end if;
  if obligation_record.remaining_hits <> expected_remaining then
    raise exception 'Stale remaining hit count';
  end if;
  if obligation_record.remaining_hits <= 0 then
    raise exception 'Hit obligation is already complete';
  end if;

  update public.hit_obligations
  set
    remaining_hits = obligation_record.remaining_hits - 1,
    delivered_hits = obligation_record.delivered_hits + 1
  where id = obligation_record.id;

  return jsonb_build_object(
    'id', obligation_record.id,
    'remainingHits',
      private.serialize_exact_integer(obligation_record.remaining_hits - 1),
    'deliveredHits',
      private.serialize_exact_integer(obligation_record.delivered_hits + 1)
  );
end;
$$;

revoke all on function public.start_game_round(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.play_game_action(uuid, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.record_physical_hit(uuid, numeric)
  from public, anon, authenticated;

grant execute on function public.start_game_round(uuid, bigint)
  to authenticated;
grant execute on function public.play_game_action(uuid, bigint, text, text)
  to authenticated;
grant execute on function public.record_physical_hit(uuid, numeric)
  to authenticated;

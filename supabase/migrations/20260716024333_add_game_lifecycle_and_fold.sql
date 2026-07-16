alter table public.room_members
  add column last_seen_at timestamptz not null default clock_timestamp();

create index room_members_room_last_seen_at_idx
  on public.room_members (room_id, last_seen_at desc);

create or replace function private.set_game_room_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := pg_catalog.clock_timestamp();
  end if;
  return new;
end;
$function$;

drop trigger if exists game_rooms_set_updated_at
  on public.game_rooms;
create trigger game_rooms_set_updated_at
before update on public.game_rooms
for each row execute function private.set_game_room_updated_at();

alter table public.game_actions
  drop constraint game_actions_action_name_check,
  drop constraint game_actions_raise_shape_check,
  add constraint game_actions_action_name_check
    check (action_name in ('call', 'raise', 'fold')),
  add constraint game_actions_raise_shape_check check (
    (action_name in ('call', 'fold') and raise_to is null)
    or (
      action_name = 'raise'
      and raise_to > 0
      and raise_to = trunc(raise_to)
    )
  );

-- Rounds created before this deployment had no server-authoritative folding
-- semantics. Canonicalize every schema-2 row so null, malformed, or mutually
-- inconsistent legacy values cannot block the strict client or action RPC.
update public.game_rooms
set state = jsonb_set(
  jsonb_set(
    state,
    '{foldedPlayerIds}',
    '[]'::jsonb,
    true
  ),
  '{foldedStakes}',
  '{}'::jsonb,
  true
)
where state ->> 'schema' = '2';

drop function private.build_public_round_state(
  uuid, bigint, uuid[], jsonb, numeric, numeric, uuid, uuid,
  text, uuid[], text, jsonb, uuid[]
);

create or replace function private.build_public_round_state(
  input_round_token uuid,
  input_round_number bigint,
  input_player_ids uuid[],
  input_folded_player_ids uuid[],
  input_folded_stakes jsonb,
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
as $function$
  select jsonb_build_object(
    'schema', 2,
    'roundToken', input_round_token,
    'roundNumber', input_round_number,
    'playerIds', to_jsonb(input_player_ids),
    'foldedPlayerIds', to_jsonb(input_folded_player_ids),
    'foldedStakes', input_folded_stakes,
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
$function$;

create or replace function private.lock_waiting_room_member_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  room_status text;
begin
  select room.status
  into room_status
  from public.game_rooms as room
  where room.id = old.room_id
  for update;

  if not found then
    return old;
  end if;
  if room_status not in ('waiting', 'closed') then
    raise exception 'Room members can be removed only while the room is waiting or closed';
  end if;
  return old;
end;
$function$;

create or replace function private.finish_game_room(target_room uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.game_rooms
  set
    status = 'closed',
    state = '{}'::jsonb,
    version = version + 1
  where id = target_room
    and status <> 'closed';

  if found then
    delete from public.room_members
    where room_id = target_room;
  end if;
end;
$function$;

create or replace function public.touch_room_presence(target_room uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_id uuid := auth.uid();
  touched_at timestamptz;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;

  update public.room_members
  set last_seen_at = clock_timestamp()
  where room_id = target_room
    and user_id = caller_id
  returning last_seen_at into touched_at;

  if not found then
    raise exception 'Caller is not a room member';
  end if;
  return jsonb_build_object('lastSeenAt', touched_at);
end;
$function$;

create or replace function public.close_game_room(
  target_room uuid,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
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

  if not found or room_record.status = 'closed' then
    return jsonb_build_object('closed', true);
  end if;
  if room_record.host_id <> caller_id
    or not private.is_room_member(target_room, caller_id)
  then
    raise exception 'Only the active room host may close the room';
  end if;
  if room_record.version <> expected_version then
    raise exception 'Stale room version';
  end if;

  perform private.finish_game_room(target_room);
  return jsonb_build_object('closed', true);
end;
$function$;

create or replace function public.leave_game_room(
  target_room uuid,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
  caller_is_member boolean;
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

  if not found or room_record.status = 'closed' then
    return jsonb_build_object('left', true);
  end if;

  select exists (
    select 1
    from public.room_members as member
    where member.room_id = target_room
      and member.user_id = caller_id
  ) into caller_is_member;
  if not caller_is_member then
    return jsonb_build_object('left', true);
  end if;
  if room_record.version <> expected_version then
    raise exception 'Stale room version';
  end if;

  if room_record.status = 'waiting' and room_record.host_id = caller_id then
    delete from public.game_rooms
    where id = target_room;
  elsif room_record.status = 'waiting' then
    delete from public.room_members
    where room_id = target_room
      and user_id = caller_id;
  elsif room_record.status in ('playing', 'showdown') then
    perform private.finish_game_room(target_room);
  end if;

  return jsonb_build_object('left', true);
end;
$function$;

create or replace function public.expire_idle_game_room(target_room uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;

  select room.*
  into room_record
  from public.game_rooms as room
  where room.id = target_room
  for update;

  if not found or room_record.status = 'closed' then
    return jsonb_build_object('expired', true);
  end if;
  if not private.is_room_member(target_room, caller_id) then
    raise exception 'Caller is not an active room member';
  end if;

  if room_record.status = 'playing'
    and room_record.updated_at <= clock_timestamp() - interval '2 minutes'
  then
    perform private.finish_game_room(target_room);
    return jsonb_build_object('expired', true);
  end if;
  return jsonb_build_object('expired', false);
end;
$function$;

create or replace function private.expire_idle_game_rooms()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  stale_room record;
begin
  for stale_room in
    select room.id
    from public.game_rooms as room
    where room.status = 'playing'
      and room.updated_at <= clock_timestamp() - interval '2 minutes'
    for update skip locked
  loop
    perform private.finish_game_room(stale_room.id);
  end loop;
end;
$function$;

create extension if not exists pg_cron;

do $cron_setup$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select job.jobid
    from cron.job as job
    where job.jobname = 'expire-idle-ddakbam-games'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
end;
$cron_setup$;

select cron.schedule(
  'expire-idle-ddakbam-games',
  '*/1 * * * *',
  'select private.expire_idle_game_rooms();'
);

revoke all on function private.build_public_round_state(
  uuid, bigint, uuid[], uuid[], jsonb, jsonb, numeric, numeric,
  uuid, uuid, text, uuid[], text, jsonb, uuid[]
) from public, anon, authenticated;
revoke all on function private.set_game_room_updated_at()
  from public, anon, authenticated;
revoke all on function private.lock_waiting_room_member_delete()
  from public, anon, authenticated;
revoke all on function private.finish_game_room(uuid)
  from public, anon, authenticated;
revoke all on function private.expire_idle_game_rooms()
  from public, anon, authenticated;

revoke all on function public.start_game_round(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.play_game_action(uuid, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.touch_room_presence(uuid)
  from public, anon, authenticated;
revoke all on function public.close_game_room(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.leave_game_room(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.expire_idle_game_room(uuid)
  from public, anon, authenticated;

grant execute on function public.start_game_round(uuid, bigint)
  to authenticated;
grant execute on function public.play_game_action(uuid, bigint, text, text)
  to authenticated;
grant execute on function public.touch_room_presence(uuid)
  to authenticated;
grant execute on function public.close_game_room(uuid, bigint)
  to authenticated;
grant execute on function public.leave_game_room(uuid, bigint)
  to authenticated;
grant execute on function public.expire_idle_game_room(uuid)
  to authenticated;

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
as $function$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
  state_record jsonb;
  betting_record jsonb;
  current_round_token uuid;
  round_number bigint;
  player_ids uuid[];
  ordered_member_ids uuid[];
  folded_player_ids uuid[];
  next_folded_player_ids uuid[];
  active_player_ids uuid[];
  pending_player_ids uuid[];
  next_pending_player_ids uuid[] := array[]::uuid[];
  player_count integer;
  actor_index integer;
  offset_index integer;
  candidate_id uuid;
  commitments jsonb;
  folded_stakes jsonb;
  current_stake numeric;
  next_stake numeric;
  current_pot numeric;
  current_commitment numeric;
  commitment_value numeric;
  commitment_total numeric := 0;
  frozen_stake numeric;
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
  if action_name not in ('call', 'raise', 'fold') then
    raise exception 'Action must be call, raise, or fold';
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
    or jsonb_typeof(state_record -> 'playerIds') <> 'array'
    or jsonb_typeof(state_record -> 'foldedPlayerIds') <> 'array'
    or jsonb_typeof(state_record -> 'foldedStakes') <> 'object'
    or jsonb_typeof(state_record -> 'betting') <> 'object'
    or jsonb_typeof(state_record -> 'evaluations') <> 'object'
    or jsonb_typeof(state_record -> 'winnerIds') <> 'array'
    or state_record -> 'evaluations' <> '{}'::jsonb
    or state_record -> 'winnerIds' <> '[]'::jsonb
    or (select count(*) from jsonb_object_keys(state_record)) <> 10
    or exists (
      select 1
      from jsonb_object_keys(state_record) as state_key
      where state_key <> all (array[
        'schema', 'roundToken', 'roundNumber', 'playerIds',
        'foldedPlayerIds', 'foldedStakes', 'betting', 'phase',
        'evaluations', 'winnerIds'
      ]::text[])
    )
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

  select coalesce(array_agg(value::uuid order by ordinal), array[]::uuid[])
  into folded_player_ids
  from jsonb_array_elements_text(state_record -> 'foldedPlayerIds')
    with ordinality as listed(value, ordinal);
  if cardinality(array(
      select distinct folded_player_id
      from unnest(folded_player_ids) as folded_player_id
    )) <> cardinality(folded_player_ids)
    or exists (
      select 1
      from unnest(folded_player_ids) as folded_player_id
      where not (folded_player_id = any (player_ids))
    )
    or folded_player_ids is distinct from array(
      select listed_player_id
      from unnest(player_ids) as listed_player_id
      where listed_player_id = any (folded_player_ids)
    )
  then
    raise exception 'Folded players must be in seat order';
  end if;

  folded_stakes := state_record -> 'foldedStakes';
  if (select count(*) from jsonb_object_keys(folded_stakes))
      <> cardinality(folded_player_ids)
    or exists (
      select 1
      from jsonb_object_keys(folded_stakes) as folded_key
      where not (folded_key::uuid = any (folded_player_ids))
    )
  then
    raise exception 'Folded stake keys do not match folded players';
  end if;

  active_player_ids := array(
    select listed_player_id
    from unnest(player_ids) as listed_player_id
    where not (listed_player_id = any (folded_player_ids))
  );
  if cardinality(active_player_ids) < 2 then
    raise exception 'At least two active players must remain while betting';
  end if;
  if caller_id = any (folded_player_ids) then
    raise exception 'A folded player cannot act';
  end if;

  betting_record := state_record -> 'betting';
  if betting_record ->> 'status' <> 'betting'
    or jsonb_typeof(betting_record -> 'playerIds') <> 'array'
    or betting_record -> 'playerIds' <> state_record -> 'playerIds'
    or jsonb_typeof(betting_record -> 'commitments') <> 'object'
    or jsonb_typeof(betting_record -> 'pendingPlayerIds') <> 'array'
    or (select count(*) from jsonb_object_keys(betting_record)) <> 8
  then
    raise exception 'Betting state is invalid';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(betting_record) as betting_key
    where betting_key <> all (array[
      'playerIds', 'commitments', 'currentStake', 'pot',
      'turnPlayerId', 'lastAggressorId', 'status', 'pendingPlayerIds'
    ]::text[])
  ) then
    raise exception 'Unexpected betting state key';
  end if;

  commitments := betting_record -> 'commitments';
  if (select count(*) from jsonb_object_keys(commitments)) <> player_count
    or exists (
      select 1
      from jsonb_object_keys(commitments) as commitment_key
      where not (commitment_key::uuid = any (player_ids))
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

  foreach candidate_id in array folded_player_ids loop
    frozen_stake := private.parse_exact_nonnegative_integer(
      folded_stakes ->> candidate_id::text,
      false
    );
    commitment_value := private.parse_exact_nonnegative_integer(
      commitments ->> candidate_id::text,
      true
    );
    if frozen_stake <> commitment_value or frozen_stake > current_stake then
      raise exception 'Folded stakes must match frozen commitments';
    end if;
  end loop;

  select coalesce(array_agg(value::uuid order by ordinal), array[]::uuid[])
  into pending_player_ids
  from jsonb_array_elements_text(betting_record -> 'pendingPlayerIds')
    with ordinality as listed(value, ordinal);
  if cardinality(pending_player_ids) = 0
    or pending_player_ids[1] <> caller_id
    or cardinality(array(
      select distinct pending_player_id
      from unnest(pending_player_ids) as pending_player_id
    )) <> cardinality(pending_player_ids)
    or exists (
      select 1
      from unnest(pending_player_ids) as pending_id
      where not (pending_id = any (active_player_ids))
    )
    or exists (
      select 1
      from unnest(folded_player_ids) as folded_id
      where folded_id = any (pending_player_ids)
    )
    or (betting_record ->> 'turnPlayerId')::uuid is distinct from caller_id
  then
    raise exception 'Folded players cannot remain pending; only the current turn player may act';
  end if;

  foreach candidate_id in array active_player_ids loop
    commitment_value := private.parse_exact_nonnegative_integer(
      commitments ->> candidate_id::text,
      true
    );
    if ((candidate_id = any (pending_player_ids)) and commitment_value >= current_stake)
      or ((not candidate_id = any (pending_player_ids)) and commitment_value <> current_stake)
    then
      raise exception 'Pending players do not match active commitments';
    end if;
  end loop;

  last_aggressor_id := nullif(betting_record ->> 'lastAggressorId', '')::uuid;
  if last_aggressor_id is not null
    and (
      not (last_aggressor_id = any (active_player_ids))
      or last_aggressor_id = any (folded_player_ids)
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
  next_folded_player_ids := folded_player_ids;

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
      if candidate_id = any (active_player_ids) then
        next_pending_player_ids := array_append(
          next_pending_player_ids,
          candidate_id
        );
      end if;
    end loop;
    next_turn_player_id := next_pending_player_ids[1];
    last_aggressor_id := caller_id;
  elsif action_name = 'fold' then
    if raise_to is not null then
      raise exception 'Fold cannot include a raise amount';
    end if;
    next_stake := current_stake;
    commitments := jsonb_set(
      commitments,
      array[caller_id::text],
      private.serialize_exact_integer(current_stake),
      false
    );
    next_pot := current_pot + current_stake - current_commitment;
    folded_stakes := jsonb_set(
      folded_stakes,
      array[caller_id::text],
      private.serialize_exact_integer(current_stake),
      true
    );
    next_folded_player_ids := array(
      select listed_player_id
      from unnest(player_ids) as listed_player_id
      where listed_player_id = any (array_append(folded_player_ids, caller_id))
    );
    active_player_ids := array(
      select listed_player_id
      from unnest(player_ids) as listed_player_id
      where not (listed_player_id = any (next_folded_player_ids))
    );
    select coalesce(array_agg(pending_id order by ordinal), array[]::uuid[])
    into next_pending_player_ids
    from unnest(pending_player_ids) with ordinality
      as pending(pending_id, ordinal)
    where ordinal > 1
      and pending_id = any (active_player_ids);
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
    select coalesce(array_agg(pending_id order by ordinal), array[]::uuid[])
    into next_pending_player_ids
    from unnest(pending_player_ids) with ordinality
      as pending(pending_id, ordinal)
    where ordinal > 1
      and pending_id = any (active_player_ids);
  end if;

  if cardinality(active_player_ids) = 1 then
    betting_status := 'complete';
    next_phase := 'showdown';
    next_pending_player_ids := array[]::uuid[];
    next_turn_player_id := null;
  elsif action_name <> 'raise' then
    if cardinality(next_pending_player_ids) = 0 then
      foreach candidate_id in array active_player_ids loop
        if private.parse_exact_nonnegative_integer(
          commitments ->> candidate_id::text,
          true
        ) <> current_stake then
          raise exception 'Betting cannot complete before active commitments match';
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
      if candidate_id = any (active_player_ids)
        and (
          hand_rank > best_rank
          or (hand_rank = best_rank and hand_tiebreak > best_tiebreak)
        )
      then
        best_rank := hand_rank;
        best_tiebreak := hand_tiebreak;
      end if;
    end loop;

    if cardinality(active_player_ids) = 1 then
      winner_ids := active_player_ids;
    else
      foreach candidate_id in array active_player_ids loop
        if (evaluations -> candidate_id::text ->> 'rank')::integer = best_rank
          and (evaluations -> candidate_id::text ->> 'tiebreak')::integer
            = best_tiebreak
        then
          winner_ids := array_append(winner_ids, candidate_id);
        end if;
      end loop;
    end if;
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
          if candidate_id = any (next_folded_player_ids) then
            frozen_stake := private.parse_exact_nonnegative_integer(
              folded_stakes ->> candidate_id::text,
              false
            );
          else
            frozen_stake := current_stake;
          end if;
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
            frozen_stake,
            frozen_stake,
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
    next_folded_player_ids,
    folded_stakes,
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
$function$;

create or replace function public.start_game_round(
  target_room uuid,
  expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
  player_ids uuid[];
  previous_player_ids uuid[];
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
    if jsonb_typeof(room_record.state -> 'playerIds') <> 'array' then
      raise exception 'Round players no longer match room membership';
    end if;
    select array_agg(value::uuid order by ordinal)
    into previous_player_ids
    from jsonb_array_elements_text(room_record.state -> 'playerIds')
      with ordinality as listed(value, ordinal);
    if previous_player_ids is distinct from player_ids then
      raise exception 'Round players no longer match room membership';
    end if;
    if exists (
      select 1
      from public.room_members as member
      where member.room_id = target_room
        and member.last_seen_at < clock_timestamp() - interval '60 seconds'
    ) then
      raise exception 'Every player must be online';
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
    array[]::uuid[],
    '{}'::jsonb,
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
$function$;

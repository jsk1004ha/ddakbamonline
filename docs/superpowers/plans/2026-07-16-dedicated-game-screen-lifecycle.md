# Dedicated Game Screen Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make online Seotda use a large dedicated game surface, add server-authoritative folding, and safely return every participant to the game main when a player leaves or a game is idle for two minutes.

**Architecture:** Keep the lobby and game on the existing page, but make `AccountRoomPanel` switch to a dedicated `OnlineRoomGame` branch while a room is playing. Extend the pure betting model and schema-2 public round contract with folded players and per-player frozen stakes, then mirror those invariants in one Supabase migration whose locked RPCs own presence, actions, settlement, next-round admission, leaving, and expiry. Realtime remains the fast synchronization path; 20-second heartbeats and 10-second server-checked expiry polls provide recovery when realtime or a client disappears.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase Auth/Postgres/Realtime, PL/pgSQL, Node test runner, Playwright game harness, Vercel.

---

## File map and locked interfaces

- Modify `src/lib/game/engine.mjs`: pure immutable fold transition and folded-state validation.
- Modify `tests/game-engine.test.mjs`: 2–4 player folding, turn skipping, exact frozen stakes, sole survivor, and malformed rehydrated state.
- Modify `src/lib/game/online-round.mjs` and `src/lib/game/online-round.d.mts`: strict runtime and TypeScript contracts for expanded card-free public state.
- Modify `tests/online-round.test.mjs`: public-state, client-RPC, privacy, and dedicated-layout contracts.
- Create `supabase/migrations/20260716090000_add_game_lifecycle_and_fold.sql`: presence, folding, next-round admission, lifecycle RPCs, and scheduled expiry.
- Create `tests/game-lifecycle-migration.test.mjs`: static security and lifecycle migration contract.
- Modify `src/lib/supabase/database.types.ts`: `last_seen_at` and new RPC signatures.
- Modify `src/components/account-room-panel.tsx`: lobby/game branch boundary, closed-room recovery, and RPC-based leaving.
- Modify `src/components/online-room-game.tsx`: heartbeat/expiry loops, fold/end controls, presence indicators, and large table layout.
- Modify `src/app/globals.css`: full-width playing shell and responsive card dimensions.
- Modify `scripts/live-authority-qa.mjs` and `tests/live-authority-qa.test.mjs`: real multi-account lifecycle assertions.
- Modify `progress.md`: local, remote, visual, and production evidence.

The public round stays at `schema: 2` and gains two exact top-level fields:

```ts
foldedPlayerIds: string[];
foldedStakes: Record<string, number | string>;
```

`foldedPlayerIds` is in original seat order. `foldedStakes` has exactly the same keys, and each value is the `currentStake` at the fold transition. `playerIds` and `commitments` continue to cover all players; `pendingPlayerIds`, `turnPlayerId`, and winner comparison cover only non-folded players.

The new authenticated RPC surface is fixed as:

```ts
touch_room_presence(target_room: string): Json;
leave_game_room(target_room: string, expected_version: number): Json;
close_game_room(target_room: string, expected_version: number): Json;
expire_idle_game_room(target_room: string): Json;
```

### Task 1: Add folding to the pure betting engine

**Files:**
- Modify: `src/lib/game/engine.mjs:237-486`
- Test: `tests/game-engine.test.mjs:167-356`

- [ ] **Step 1: Write failing fold-transition tests**

Add after the existing raise tests:

```js
test("fold freezes the current stake and skips that player on later raises", () => {
  let state = createBettingState(["a", "b", "c", "d"]);
  state = applyAction(state, "a", { type: "call" });
  state = applyAction(state, "b", { type: "raise", amount: 5 });
  state = applyAction(state, "c", { type: "fold" });

  assert.deepEqual(state.foldedPlayerIds, ["c"]);
  assert.deepEqual(state.foldedStakes, { c: 5 });
  assert.deepEqual(state.commitments, { a: 1, b: 5, c: 5, d: 0 });
  assert.equal(state.pot, 11);
  assert.equal(state.turnPlayerId, "d");

  state = applyAction(state, "d", { type: "raise", amount: 9 });
  assert.deepEqual(state.pendingPlayerIds, ["a", "b"]);
  assert.equal(state.foldedStakes.c, 5);
});

test("fold completes immediately when one active player remains", () => {
  let state = createBettingState(["a", "b", "c"]);
  state = applyAction(state, "a", { type: "fold" });
  state = applyAction(state, "b", { type: "fold" });

  assert.equal(state.status, "complete");
  assert.equal(state.turnPlayerId, null);
  assert.deepEqual(state.pendingPlayerIds, []);
  assert.deepEqual(state.foldedPlayerIds, ["a", "b"]);
  assert.deepEqual(state.foldedStakes, { a: 1, b: 1 });
});

test("four-player folds preserve original seat order", () => {
  let state = createBettingState(["a", "b", "c", "d"], 3, 2);
  state = applyAction(state, "c", { type: "fold" });
  state = applyAction(state, "d", { type: "call" });
  state = applyAction(state, "a", { type: "fold" });

  assert.deepEqual(state.foldedPlayerIds, ["a", "c"]);
  assert.deepEqual(state.foldedStakes, { a: 3, c: 3 });
  assert.equal(state.turnPlayerId, "b");
});

test("rehydrated folded state rejects incoherent keys, stakes, and turns", () => {
  const folded = applyAction(
    createBettingState(["a", "b", "c"]),
    "a",
    { type: "fold" },
  );
  for (const malformed of [
    { ...folded, foldedPlayerIds: ["a", "a"] },
    { ...folded, foldedPlayerIds: ["outsider"] },
    { ...folded, foldedStakes: {} },
    { ...folded, foldedStakes: { a: 0 } },
    { ...folded, foldedStakes: { a: 2 } },
    { ...folded, pendingPlayerIds: ["b", "a", "c"] },
    { ...folded, turnPlayerId: "a" },
  ]) {
    assert.throws(
      () => applyAction(malformed, "b", { type: "call" }),
      /invalid betting state/,
    );
  }
});
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run: `node --test --test-name-pattern="fold|folded" tests/game-engine.test.mjs`

Expected: FAIL because the state has no folded fields and `fold` is rejected.

- [ ] **Step 3: Add folded fields and state validation**

Add to `createBettingState`:

```js
foldedPlayerIds: [],
foldedStakes: {},
```

After commitment parsing in `validateBettingState`, add:

```js
if (!Array.isArray(state.foldedPlayerIds)) {
  invalidState("foldedPlayerIds must be an array");
}
if (
  state.foldedStakes === null ||
  typeof state.foldedStakes !== "object" ||
  Array.isArray(state.foldedStakes)
) {
  invalidState("foldedStakes must be an object");
}
const foldedSet = new Set(state.foldedPlayerIds);
const foldedKeys = Object.keys(state.foldedStakes);
if (
  foldedSet.size !== state.foldedPlayerIds.length ||
  state.foldedPlayerIds.some((id) => !state.playerIds.includes(id)) ||
  foldedKeys.length !== foldedSet.size ||
  foldedKeys.some((id) => !foldedSet.has(id))
) {
  invalidState("folded players and stakes must match existing players");
}
const foldedStakes = Object.fromEntries(
  state.foldedPlayerIds.map((id) => [
    id,
    canonicalQuantity(state.foldedStakes[id], `folded stake for ${id}`),
  ]),
);
for (const id of state.foldedPlayerIds) {
  if (
    foldedStakes[id] > currentStake ||
    foldedStakes[id] !== commitments[id]
  ) {
    invalidState("a folded stake must equal its frozen commitment");
  }
}
const activePlayerIds = state.playerIds.filter((id) => !foldedSet.has(id));
if (activePlayerIds.length === 0) {
  invalidState("at least one active player must remain");
}
```

Reject folded pending players. In active states validate only `activePlayerIds` against pending/commitment coherence. In complete states require a null turn, no pending players, and either one active survivor or all active commitments equal `currentStake`. Return the parsed fold data:

```js
return {
  currentStake,
  pot,
  commitments,
  foldedSet,
  activePlayerIds,
  foldedStakes,
};
```

- [ ] **Step 4: Implement the immutable fold transition**

Filter folded players out of the raise ring:

```js
const pendingPlayerIds = orderedFrom(
  state.playerIds,
  (playerIndex + 1) % state.playerIds.length,
).filter(
  (candidateId) =>
    candidateId !== playerId && !exactState.foldedSet.has(candidateId),
);
```

Insert before the call branch:

```js
if (action.type === "fold") {
  const commitments = {
    ...state.commitments,
    [playerId]: serializeExactInteger(exactState.currentStake),
  };
  const foldedPlayerIds = state.playerIds.filter(
    (id) => exactState.foldedSet.has(id) || id === playerId,
  );
  const foldedStakes = {
    ...state.foldedStakes,
    [playerId]: serializeExactInteger(exactState.currentStake),
  };
  const activePlayerIds = state.playerIds.filter(
    (id) => !foldedPlayerIds.includes(id),
  );
  const pendingPlayerIds = state.pendingPlayerIds
    .slice(1)
    .filter((id) => activePlayerIds.includes(id));
  const complete = activePlayerIds.length === 1;

  return {
    ...state,
    commitments,
    foldedPlayerIds,
    foldedStakes,
    pot: serializeExactInteger(
      exactState.pot + exactState.currentStake - currentCommitment,
    ),
    turnPlayerId: complete ? null : pendingPlayerIds[0],
    status: complete ? "complete" : "betting",
    pendingPlayerIds: complete ? [] : pendingPlayerIds,
  };
}
if (action.type !== "call") {
  throw new RangeError("action type must be call, raise, or fold");
}
```

Make call completion compare only `exactState.activePlayerIds`.

- [ ] **Step 5: Run and commit**

Replace the prior fold-rejection assertion with:

```js
assert.throws(() => applyAction(state, "a", { type: "check" }), RangeError);
```

Run: `node --test tests/game-engine.test.mjs`

Expected: all engine tests PASS.

```powershell
git add src/lib/game/engine.mjs tests/game-engine.test.mjs
git commit -m "Model folding without weakening exact stake invariants" -m "Folded players keep liability at the action-time stake and leave the active turn ring." -m "Constraint: Amounts remain exact beyond JavaScript safe integers" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: node --test tests/game-engine.test.mjs"
```

### Task 2: Expand the strict public-round contract

**Files:**
- Modify: `src/lib/game/online-round.mjs:1-230`
- Modify: `src/lib/game/online-round.d.mts:1-58`
- Test: `tests/online-round.test.mjs:16-138`

- [ ] **Step 1: Write failing parser tests**

Add `foldedPlayerIds: []` and `foldedStakes: {}` to `safeRound`, then add:

```js
test("folded hands cannot win and their exact stake stays public", () => {
  const state = {
    ...showdownRound,
    playerIds: ["a", "b", "c"],
    foldedPlayerIds: ["a"],
    foldedStakes: { a: 3 },
    betting: {
      ...showdownRound.betting,
      playerIds: ["a", "b", "c"],
      commitments: { a: 3, b: 5, c: 5 },
      currentStake: 5,
      pot: 13,
    },
    evaluations: {
      a: { name: "38광땡", rank: 3, tiebreak: 3, months: [3, 8] },
      b: { name: "알리", rank: 1, tiebreak: 6, months: [1, 2] },
      c: { name: "8끗", rank: 0, tiebreak: 8, months: [2, 6] },
    },
    winnerIds: ["b"],
  };
  assert.deepEqual(readPublicOnlineRound(state), state);
});

test("rejects malformed folded state", () => {
  for (const state of [
    { ...safeRound, foldedPlayerIds: ["outsider"], foldedStakes: { outsider: 1 } },
    { ...safeRound, foldedPlayerIds: ["a", "a"], foldedStakes: { a: 1 } },
    { ...safeRound, foldedPlayerIds: ["a"], foldedStakes: {} },
    { ...safeRound, foldedPlayerIds: ["a"], foldedStakes: { a: 2 } },
    { ...showdownRound, foldedPlayerIds: ["a"], foldedStakes: { a: 3 } },
  ]) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});
```

Run: `node --test tests/online-round.test.mjs`

Expected: FAIL on strict keys and active-only winner selection.

- [ ] **Step 2: Parse folded IDs and exact stakes**

Add both keys to `ROUND_KEYS` and add:

```js
function readFoldedState(value, playerIds, commitments, currentStake) {
  const { foldedPlayerIds, foldedStakes } = value;
  if (
    !isPlayerList(foldedPlayerIds) ||
    foldedPlayerIds.some((id) => !playerIds.includes(id)) ||
    !isRecord(foldedStakes)
  ) {
    return null;
  }
  const keys = Object.keys(foldedStakes);
  if (
    keys.length !== foldedPlayerIds.length ||
    keys.some((id) => !foldedPlayerIds.includes(id))
  ) {
    return null;
  }
  for (const id of foldedPlayerIds) {
    const stake = parseExactQuantity(foldedStakes[id], false);
    if (stake === null || stake > currentStake || stake !== commitments.get(id)) {
      return null;
    }
  }
  return new Set(foldedPlayerIds);
}
```

Change `readBetting` to receive `foldedSet`, reject folded pending IDs, validate only active commitments, and accept complete state when one active player remains. Change `readShowdown` to receive `foldedSet`, still validate evaluations for every dealt player, but compute strongest and expected winners from:

```js
const activePlayerIds = playerIds.filter((id) => !foldedSet.has(id));
```

Reject any winner in `foldedSet`.

- [ ] **Step 3: Update TypeScript declarations and run tests**

Add to `PublicRoundBase`:

```ts
foldedPlayerIds: string[];
foldedStakes: Record<string, PublicExactQuantity>;
```

Run: `node --test tests/online-round.test.mjs`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 4: Commit**

```powershell
git add src/lib/game/online-round.mjs src/lib/game/online-round.d.mts tests/online-round.test.mjs
git commit -m "Keep folded-round data strict and card-free" -m "The client accepts only server-shaped frozen stakes and excludes folded players from winner validation." -m "Constraint: Public room JSON never exposes card identifiers" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: online-round tests and TypeScript check"
```

### Task 3: Define the server lifecycle contract before SQL implementation

**Files:**
- Create: `tests/game-lifecycle-migration.test.mjs`
- Create: `supabase/migrations/20260716090000_add_game_lifecycle_and_fold.sql`
- Modify: `tests/server-authority-migration.test.mjs:70-135`

- [ ] **Step 1: Create the failing migration test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(
  new URL(
    "../supabase/migrations/20260716090000_add_game_lifecycle_and_fold.sql",
    import.meta.url,
  ),
  "utf8",
);

test("presence is server-owned and does not touch room action time", () => {
  assert.match(sql, /add column last_seen_at timestamptz not null default clock_timestamp\(\)/i);
  assert.match(sql, /create or replace function public\.touch_room_presence/i);
  const start = sql.search(/create or replace function public\.touch_room_presence/i);
  const end = sql.search(/create or replace function public\.close_game_room/i);
  const body = sql.slice(start, end);
  assert.match(body, /where room_id = target_room and user_id = caller_id/i);
  assert.doesNotMatch(body, /update public\.game_rooms/i);
});

test("fold is authoritative and stores frozen stakes", () => {
  assert.match(sql, /action_name in \('call', 'raise', 'fold'\)/i);
  assert.match(sql, /action_name not in \('call', 'raise', 'fold'\)/i);
  assert.match(sql, /'foldedPlayerIds'/i);
  assert.match(sql, /'foldedStakes'/i);
  assert.match(sql, /folded_stakes := jsonb_set[\s\S]*current_stake/is);
});

test("next round requires unchanged recently present players", () => {
  const start = sql.slice(
    sql.search(/create or replace function public\.start_game_round/i),
    sql.search(/create or replace function public\.play_game_action/i),
  );
  assert.match(start, /ordered_member_ids is distinct from previous_player_ids/i);
  assert.match(start, /last_seen_at < clock_timestamp\(\) - interval '60 seconds'/i);
  assert.match(start, /raise exception 'Every player must be online'/i);
});

test("leave and expiry lock, close, and clear memberships", () => {
  for (const name of ["leave_game_room", "close_game_room", "expire_idle_game_room"]) {
    const offset = sql.search(new RegExp(`create or replace function public\\.${name}`, "i"));
    const body = sql.slice(offset, offset + 4500);
    assert.notEqual(offset, -1);
    assert.match(body, /from public\.game_rooms[\s\S]*for update/is);
  }
  assert.match(sql, /updated_at > clock_timestamp\(\) - interval '2 minutes'/i);
  assert.match(sql, /set status = 'closed'/i);
  assert.match(sql, /delete from public\.room_members/i);
});

test("cron cleanup is idempotent and preserves settled data", () => {
  assert.match(sql, /create extension if not exists pg_cron with schema extensions/i);
  assert.match(sql, /create or replace function private\.expire_idle_game_rooms/i);
  assert.match(sql, /expire-idle-ddakbam-games/i);
  assert.doesNotMatch(sql, /delete from public\.game_results/i);
  assert.doesNotMatch(sql, /delete from public\.hit_obligations/i);
});

test("new public RPCs are authenticated security definers", () => {
  for (const name of [
    "touch_room_presence",
    "leave_game_room",
    "close_game_room",
    "expire_idle_game_room",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `create or replace function public\\.${name}[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
        "i",
      ),
    );
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}`, "i"));
  }
});
```

Run: `node --test tests/game-lifecycle-migration.test.mjs`

Expected: FAIL with `ENOENT`.

- [ ] **Step 2: Update the historical assertion without rewriting history**

In `tests/server-authority-migration.test.mjs` keep the 2026-07-15 SQL assertion at call/raise. The new test owns fold behavior; do not edit the historical migration.


- [ ] **Step 3: Add presence storage and fold-capable state shape**

Create the migration with these schema changes first:

```sql
alter table public.room_members
  add column last_seen_at timestamptz not null default clock_timestamp();

create index room_members_room_presence_idx
  on public.room_members (room_id, last_seen_at desc);

alter table public.game_actions
  drop constraint game_actions_action_name_check,
  drop constraint game_actions_raise_shape_check;

alter table public.game_actions
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
```

Drop and recreate `private.build_public_round_state` with two additional parameters immediately before phase:

```sql
input_folded_player_ids uuid[],
input_folded_stakes jsonb,
```

Build the added fields exactly as:

```sql
'foldedPlayerIds', to_jsonb(input_folded_player_ids),
'foldedStakes', input_folded_stakes,
```

Before replacing the RPCs, keep any active schema-2 room readable:

```sql
update public.game_rooms
set state = state || jsonb_build_object(
  'foldedPlayerIds', '[]'::jsonb,
  'foldedStakes', '{}'::jsonb
)
where state ->> 'schema' = '2'
  and not state ? 'foldedPlayerIds';
```

- [ ] **Step 4: Replace round start with recent-presence admission**

Copy the existing locked `public.start_game_round(uuid, bigint)` definition into the new migration. Add:

```sql
previous_player_ids uuid[];
ordered_member_ids uuid[];
offline_count integer;
```

Keep existing first-round ready checks. In the next-round branch, after verifying showdown, add:

```sql
select array_agg(value::uuid order by ordinal)
into previous_player_ids
from jsonb_array_elements_text(room_record.state -> 'playerIds')
  with ordinality as listed(value, ordinal);

select array_agg(member.user_id order by member.seat)
into ordered_member_ids
from public.room_members as member
where member.room_id = target_room;

if ordered_member_ids is distinct from previous_player_ids then
  raise exception 'Round players no longer match room membership';
end if;

select count(*) into offline_count
from public.room_members as member
where member.room_id = target_room
  and member.last_seen_at < clock_timestamp() - interval '60 seconds';

if offline_count <> 0 then
  raise exception 'Every player must be online';
end if;
```

Pass `array[]::uuid[]` and `'{}'::jsonb` into the expanded state builder for every new round. Preserve host, room lock, version, 2–4 player, hand insert, status, and version checks.

- [ ] **Step 5: Replace game action with fold-aware settlement**

Copy the current `public.play_game_action(uuid, bigint, text, text)` into the migration. Add:

```sql
folded_player_ids uuid[] := array[]::uuid[];
next_folded_player_ids uuid[] := array[]::uuid[];
active_player_ids uuid[] := array[]::uuid[];
folded_stakes jsonb := '{}'::jsonb;
loser_stake numeric;
```

Allow `call`, `raise`, and `fold`. Parse folded IDs in seat order, require unique IDs from `player_ids`, require folded-stake keys to match, require every frozen value to be positive, no greater than current stake, and equal to that player’s commitment. Reject any folded player in `pending_player_ids`.

In the raise branch, append only active candidates to the new pending ring. Add this fold branch before call handling:

```sql
elsif action_name = 'fold' then
  if raise_to is not null then
    raise exception 'Fold cannot include a raise amount';
  end if;
  commitments := jsonb_set(
    commitments,
    array[caller_id::text],
    private.serialize_exact_integer(current_stake),
    false
  );
  next_pot := current_pot + current_stake - current_commitment;
  next_stake := current_stake;
  next_folded_player_ids := array(
    select player_id
    from unnest(player_ids) as player_id
    where player_id = any (array_append(folded_player_ids, caller_id))
  );
  folded_stakes := jsonb_set(
    folded_stakes,
    array[caller_id::text],
    private.serialize_exact_integer(current_stake),
    true
  );
  active_player_ids := array(
    select player_id
    from unnest(player_ids) as player_id
    where not player_id = any (next_folded_player_ids)
  );
  next_pending_player_ids := array(
    select player_id
    from unnest(pending_player_ids[2:cardinality(pending_player_ids)]) as player_id
    where player_id = any (active_player_ids)
  );
  if cardinality(active_player_ids) = 1 then
    betting_status := 'complete';
    next_phase := 'showdown';
    next_turn_player_id := null;
    next_pending_player_ids := array[]::uuid[];
  else
    next_turn_player_id := next_pending_player_ids[1];
  end if;
```

For call and raise, copy `folded_player_ids` to `next_folded_player_ids`. At showdown evaluate all hands for display, but compute strongest and winners only for IDs in `active_player_ids`. If one active player remains, set `winner_ids := active_player_ids`.

Keep `game_results.stake` at the final current stake. Replace obligation amounts so a folded loser uses the frozen value and an active loser uses the final value:

```sql
loser_stake := case
  when candidate_id = any (next_folded_player_ids)
    then private.parse_exact_nonnegative_integer(
      folded_stakes ->> candidate_id::text,
      false
    )
  else next_stake
end;
```

Insert `loser_stake` into both `initial_hits` and `remaining_hits`. Create obligations only if `sole_winner_id is not null`, so an active tie creates no debt for anyone, including folded players. Pass both folded fields to the state builder and keep the action-log/version idempotency.

- [ ] **Step 6: Add lifecycle functions and closed-member cleanup**

Update `private.lock_waiting_room_member_delete()` to allow status `closed` as well as `waiting`. The RLS policy still grants direct browser deletion only for waiting rooms.

Add:

```sql
create or replace function public.touch_room_presence(target_room uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  touched_at timestamptz := clock_timestamp();
begin
  if caller_id is null then raise exception 'Authentication required'; end if;
  update public.room_members
  set last_seen_at = touched_at
  where room_id = target_room and user_id = caller_id;
  if not found then raise exception 'Caller is not a room member'; end if;
  return jsonb_build_object('lastSeenAt', touched_at);
end;
$$;

create or replace function private.finish_game_room(target_room uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.game_rooms
  set status = 'closed', state = '{}'::jsonb
  where id = target_room and status <> 'closed';
  delete from public.room_members where room_id = target_room;
end;
$$;
```

Add locked `close_game_room(target_room, expected_version)` that requires auth, exact version, active membership, and host identity, then calls `private.finish_game_room`. Add locked `leave_game_room`: in waiting state retain existing host-delete/member-delete behavior; in playing/showdown state any active member closes the whole room. Missing or already-removed membership returns `{"closed": true}` idempotently.

Add locked expiry:

```sql
create or replace function public.expire_idle_game_room(target_room uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  room_record public.game_rooms%rowtype;
begin
  if caller_id is null then raise exception 'Authentication required'; end if;
  select room.* into room_record
  from public.game_rooms as room
  where room.id = target_room
  for update;
  if not found then return jsonb_build_object('expired', true); end if;
  if not private.is_room_member(target_room, caller_id) then
    raise exception 'Caller is not a room member';
  end if;
  if room_record.status = 'closed' then
    return jsonb_build_object('expired', true);
  end if;
  if room_record.status <> 'playing'
    or room_record.updated_at > clock_timestamp() - interval '2 minutes'
  then
    return jsonb_build_object('expired', false);
  end if;
  perform private.finish_game_room(target_room);
  return jsonb_build_object('expired', true);
end;
$$;
```

The existing `game_rooms_set_updated_at` trigger means only successful round starts/actions move the activity clock. Presence touches only `room_members`.

- [ ] **Step 7: Add scheduled expiry and privileges**

```sql
create or replace function private.expire_idle_game_rooms()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_room uuid;
begin
  for target_room in
    select id
    from public.game_rooms
    where status = 'playing'
      and updated_at <= clock_timestamp() - interval '2 minutes'
    for update skip locked
  loop
    perform private.finish_game_room(target_room);
  end loop;
end;
$$;

create extension if not exists pg_cron with schema extensions;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
  from cron.job
  where jobname = 'expire-idle-ddakbam-games';
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
  perform cron.schedule(
    'expire-idle-ddakbam-games',
    '*/1 * * * *',
    'select private.expire_idle_game_rooms()'
  );
end;
$$;
```

Revoke all access to the new private functions. Revoke all new public RPCs from `public, anon, authenticated`, then grant execute only to `authenticated`. Update the expanded state-builder signature in its revoke statement.

- [ ] **Step 8: Verify and commit the migration**

Run: `node --test tests/server-authority-migration.test.mjs tests/game-lifecycle-migration.test.mjs`

Expected: PASS.

Run: `npx supabase db reset`

Expected: every migration applies locally. If Docker is unavailable, run `npx supabase db lint --linked` and require the rollback compilation in Task 7 before remote apply.

```powershell
git add supabase/migrations/20260716090000_add_game_lifecycle_and_fold.sql tests/game-lifecycle-migration.test.mjs tests/server-authority-migration.test.mjs
git commit -m "Make online games terminate safely when participation breaks" -m "Presence, folding, next-round admission, leaving, settlement, and idle expiry now share locked server authority." -m "Constraint: Folded debt freezes at action time and ties create no debt" -m "Rejected: Client-only idle timers | abandoned rooms survive when all clients leave" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: migration contracts and Supabase compilation"
```

### Task 4: Expose lifecycle types and room recovery to React

**Files:**
- Modify: `src/lib/supabase/database.types.ts:140-180,350-380`
- Modify: `src/components/account-room-panel.tsx:39-45,154-230,360-708`
- Test: `tests/online-round.test.mjs:142-190`

- [ ] **Step 1: Add failing client source contracts**

Extend the authenticated RPC test:

```js
for (const rpc of [
  "touch_room_presence",
  "leave_game_room",
  "close_game_room",
  "expire_idle_game_room",
]) {
  assert.match(
    `${onlineGameSource}\n${accountRoomSource}`,
    new RegExp(`\\.rpc\\("${rpc}"`),
  );
}
assert.match(accountRoomSource, /room\.status === "closed"/);
assert.match(accountRoomSource, /accountRoom--playing/);
```

Run: `node --test tests/online-round.test.mjs`

Expected: FAIL on unwired lifecycle calls and closed-room recovery.

- [ ] **Step 2: Update database types**

Add `last_seen_at: string` to `room_members.Row` and optional versions to `Insert`/`Update`. Add:

```ts
close_game_room: {
  Args: { expected_version: number; target_room: string };
  Returns: Json;
};
expire_idle_game_room: {
  Args: { target_room: string };
  Returns: Json;
};
leave_game_room: {
  Args: { expected_version: number; target_room: string };
  Returns: Json;
};
touch_room_presence: {
  Args: { target_room: string };
  Returns: Json;
};
```

- [ ] **Step 3: Centralize return-to-main recovery**

In `AccountRoomPanel` add:

```tsx
const returnToGameMain = useCallback((message?: string) => {
  setRoom(null);
  setMembers([]);
  if (message) setRoomNotice(message);
}, []);
```

In `refreshRoom`, treat `PGRST116`, a missing row, status `closed`, or missing current-user membership as normal completion:

```tsx
if (roomError?.code === "PGRST116" || !nextRoom || nextRoom.status === "closed") {
  returnToGameMain("게임이 끝나 메인으로 돌아왔어요.");
  return;
}
const { data: membership } = await supabase
  .from("room_members")
  .select("room_id")
  .eq("room_id", roomId)
  .eq("user_id", user.id)
  .maybeSingle();
if (!membership) {
  returnToGameMain("게임이 끝나 메인으로 돌아왔어요.");
  return;
}
```

On room closed/delete or own membership delete realtime events, invoke the same helper.

- [ ] **Step 4: Route every leave through the server**

Replace direct waiting-room deletes with:

```tsx
const { error } = await supabase.rpc("leave_game_room", {
  target_room: room.id,
  expected_version: room.version,
});
if (error) {
  setRoomNotice("방을 나가지 못했어요. 최신 상태를 다시 확인해 주세요.");
  await refreshRoom(room.id);
  return;
}
returnToGameMain(
  room.status === "waiting"
    ? "방에서 나왔어요."
    : "게임을 끝내고 메인으로 돌아왔어요.",
);
```

- [ ] **Step 5: Make playing a top-level dedicated branch**

Extract the existing ledger modal into one `ledgerDialog` variable. Before the regular lobby return, add:

```tsx
if (room?.status === "playing") {
  return (
    <section className="accountRoom accountRoom--playing" aria-label="온라인 섯다 게임">
      <OnlineRoomGame
        room={room}
        members={members}
        names={names}
        userId={user.id}
        onRefreshRoom={refreshRoom}
        onNotice={setRoomNotice}
        onReturnToMain={returnToGameMain}
        onOpenLedger={() => setLedgerOpen(true)}
      />
      {roomNotice && (
        <p className="accountRoom__notice" role="status">{roomNotice}</p>
      )}
      {ledgerDialog}
    </section>
  );
}
```

Do not duplicate ledger queries or mutations.

### Task 5: Add client lifecycle loops, fold, and the large game table

**Files:**
- Modify: `src/components/online-room-game.tsx:1-390`
- Modify: `src/app/globals.css:150-340`
- Modify: `src/components/account-room-panel.tsx:740-755`
- Test: `tests/online-round.test.mjs:142-205`

- [ ] **Step 1: Add failing UI source contracts**

```js
test("dedicated game exposes fold, end, presence, and expiry controls", () => {
  assert.match(onlineGameSource, />죽기</);
  assert.match(onlineGameSource, />게임 끝내기</);
  assert.match(onlineGameSource, /20_000/);
  assert.match(onlineGameSource, /10_000/);
  assert.match(onlineGameSource, /60_000/);
  assert.match(onlineGameSource, /visibilitychange/);
  assert.match(onlineGameSource, /onlineGame__myCards/);
  assert.match(onlineGameSource, /onlineGame__opponentCards/);
});
```

Run: `node --test tests/online-round.test.mjs`

Expected: FAIL.

- [ ] **Step 2: Extend props and derive presence**

Import `useCallback`, add `Member = Tables<"room_members">`, and extend props with `members`, `onReturnToMain`, and `onOpenLedger`. Derive:

```tsx
const [presenceNow, setPresenceNow] = useState(() => Date.now());
const onlinePlayerIds = useMemo(
  () => new Set(
    members
      .filter((member) => presenceNow - Date.parse(member.last_seen_at) <= 60_000)
      .map((member) => member.user_id),
  ),
  [members, presenceNow],
);
const allPlayersOnline = Boolean(
  round && round.playerIds.every((id) => onlinePlayerIds.has(id)),
);
```

- [ ] **Step 3: Add heartbeat and expiry polling**

```tsx
const touchPresence = useCallback(async () => {
  if (!supabase) return;
  const { error } = await supabase.rpc("touch_room_presence", {
    target_room: room.id,
  });
  if (error) await onRefreshRoom(room.id);
  setPresenceNow(Date.now());
}, [onRefreshRoom, room.id, supabase]);

const expireIfIdle = useCallback(async () => {
  if (!supabase) return;
  const { data, error } = await supabase.rpc("expire_idle_game_room", {
    target_room: room.id,
  });
  if (error) {
    await onRefreshRoom(room.id);
    return;
  }
  if (data && typeof data === "object" && "expired" in data && data.expired) {
    onReturnToMain("2분 동안 게임 행동이 없어 게임이 자동 종료됐어요.");
  }
}, [onRefreshRoom, onReturnToMain, room.id, supabase]);

useEffect(() => {
  void touchPresence();
  const heartbeat = window.setInterval(() => void touchPresence(), 20_000);
  const expiry = window.setInterval(() => void expireIfIdle(), 10_000);
  const foreground = () => {
    if (document.visibilityState === "visible") {
      void touchPresence();
      void expireIfIdle();
      void onRefreshRoom(room.id);
    }
  };
  document.addEventListener("visibilitychange", foreground);
  return () => {
    window.clearInterval(heartbeat);
    window.clearInterval(expiry);
    document.removeEventListener("visibilitychange", foreground);
  };
}, [expireIfIdle, onRefreshRoom, room.id, touchPresence]);
```

- [ ] **Step 4: Add fold and end actions**

Expand `submitAction` to:

```tsx
action:
  | { type: "call" }
  | { type: "raise"; amount: string }
  | { type: "fold" },
```

Keep `raise_to` null unless type is raise. Add:

```tsx
async function endGame() {
  if (!supabase || busy) return;
  setBusy(true);
  try {
    const rpc = room.host_id === userId ? "close_game_room" : "leave_game_room";
    const { error } = await supabase.rpc(rpc, {
      target_room: room.id,
      expected_version: room.version,
    });
    if (error) {
      onNotice("게임을 끝내지 못했어요. 최신 상태를 확인해 주세요.");
      await onRefreshRoom(room.id);
      return;
    }
    onReturnToMain("게임을 끝내고 메인으로 돌아왔어요.");
  } finally {
    setBusy(false);
  }
}
```

Render `죽기` only on the user’s turn and `게임 끝내기` for every player.

- [ ] **Step 5: Make next-round denial specific**

Disable next round unless `allPlayersOnline`. Before RPC:

```tsx
if (!allPlayersOnline) {
  onNotice("참가자 접속을 확인할 수 없어 다음 판을 시작할 수 없어요.");
  return;
}
```

Map server messages `Every player must be online` and `Round players no longer match` to the same Korean notice; always refresh after rejection.

- [ ] **Step 6: Replace the compact layout**

Use a topbar, table, opponents region, large local hand, and sticky action dock:

```tsx
<section className="onlineGame" aria-labelledby="online-game-heading">
  <header className="onlineGame__topbar">
    <div>
      <small>방 {room.code} · {round.roundNumber}판</small>
      <h2 id="online-game-heading">딱밤 섯다</h2>
    </div>
    <strong>현재 {formatted(round.betting.currentStake)} 딱밤</strong>
    <div className="onlineGame__topActions">
      <button type="button" onClick={onOpenLedger}>딱밤 장부</button>
      <button type="button" disabled={busy} onClick={() => void endGame()}>
        게임 끝내기
      </button>
    </div>
  </header>
  <div className={`onlineGame__table onlineGame__table--${round.playerIds.length}`}>
    <div className="onlineGame__opponents">{opponentSeats}</div>
    <article className="onlineGame__me">
      <div className="onlineGame__myCards">{myCards}</div>
      <strong>{myEvaluation?.name ?? "패 확인 중"}</strong>
      {rankingRollup}
    </article>
  </div>
  <footer className="onlineGame__actionDock">{actionsOrResult}</footer>
</section>
```

Opponent seats use `onlineGame__opponentCards`, two backs before showdown, RLS-returned cards at showdown, `is-folded` state, and online/offline badge. Keep the compact ranking rollup under the local hand.

- [ ] **Step 7: Apply exact responsive card sizes**

Move game layout CSS to `globals.css` and remove compact inline styles:

```css
.accountRoom--playing {
  width: 100%;
  min-height: min(780px, calc(100vh - 150px));
  padding: 0;
  overflow: hidden;
}
.onlineGame {
  --my-card-w: 132px;
  --my-card-h: 194px;
  --opponent-card-w: 76px;
  --opponent-card-h: 112px;
  display: grid;
  min-height: min(780px, calc(100vh - 150px));
  grid-template-rows: auto minmax(420px, 1fr) auto;
  color: #f7ecd8;
  background: radial-gradient(circle at 50% 42%, #20584b, #0d2a25 58%, #081713);
}
.onlineGame__myCards img {
  width: var(--my-card-w);
  height: var(--my-card-h);
  object-fit: cover;
}
.onlineGame__opponentCards img {
  width: var(--opponent-card-w);
  height: var(--opponent-card-h);
  object-fit: cover;
}
.onlineGame__actionDock {
  position: sticky;
  bottom: 0;
  z-index: 3;
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px 18px;
  background: rgba(5, 16, 14, 0.96);
}
@media (max-width: 680px) {
  .onlineGame {
    --my-card-w: 96px;
    --my-card-h: 142px;
    --opponent-card-w: 58px;
    --opponent-card-h: 86px;
    min-height: calc(100vh - 96px);
  }
  .onlineGame__opponents {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .onlineGame__actionDock {
    flex-wrap: wrap;
  }
}
```

Keep every control at least 44px high and eliminate horizontal overflow at 390×844.

- [ ] **Step 8: Verify and commit Tasks 4–5 together**

Run: `node --test tests/online-round.test.mjs`

Run: `npm run lint && npm run typecheck && npm run build`

Expected: PASS and Next.js builds `/`.

```powershell
git add src/lib/supabase/database.types.ts src/components/account-room-panel.tsx src/components/online-room-game.tsx src/app/globals.css tests/online-round.test.mjs
git commit -m "Give active games the space and controls they need" -m "The account hub yields to a large table while heartbeat, expiry, fold, and exit requests remain server-authoritative." -m "Constraint: Game mode stays on the current page and cards remain RLS-protected" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: online-round tests, lint, typecheck, production build"
```

### Task 6: Extend disposable live Supabase QA

**Files:**
- Modify: `scripts/live-authority-qa.mjs:1-end`
- Modify: `tests/live-authority-qa.test.mjs:1-40`

- [ ] **Step 1: Add failing live-QA source contracts**

```js
assert.match(script, /touch_room_presence/);
assert.match(script, /action_name:\s*"fold"/);
assert.match(script, /Every player must be online/);
assert.match(script, /leave_game_room/);
assert.match(script, /expire_idle_game_room/);
assert.match(script, /last_seen_at/);
```

Run: `node --test tests/live-authority-qa.test.mjs`

Expected: FAIL.

- [ ] **Step 2: Provision four authenticated clients with strict cleanup**

Extend `scripts/live-authority-qa.mjs` with `guestTwo` and `guestThree`, provision four disposable users, and add them to `actorClient`. Track every room, result, and obligation. In `finally` delete obligations before results, rooms before auth users, then assert all disposable profile/auth IDs and QA room IDs have zero rows.

- [ ] **Step 3: Verify four-player presence, folds, and next round**

Touch all four members:

```js
await Promise.all([
  host.rpc("touch_room_presence", { target_room: qaRoomId }),
  guest.rpc("touch_room_presence", { target_room: qaRoomId }),
  guestTwo.rpc("touch_room_presence", { target_room: qaRoomId }),
  guestThree.rpc("touch_room_presence", { target_room: qaRoomId }),
]);
```

Start the round, make two legal folds at different stakes, complete showdown, and assert:

```js
assert.equal(room.state.foldedPlayerIds.length, 2);
assert.equal(room.state.phase, "showdown");
assert.ok(
  !room.state.winnerIds.some((id) => room.state.foldedPlayerIds.includes(id)),
);
if (room.state.winnerIds.length === 1) {
  const { data: debts, error } = await admin
    .from("hit_obligations")
    .select("debtor_id, creditor_id, initial_hits")
    .eq("room_id", qaRoomId);
  assert.ifError(error);
  for (const debt of debts) {
    const frozen = room.state.foldedStakes[debt.debtor_id];
    const expected = frozen ?? room.state.betting.currentStake;
    assert.equal(BigInt(debt.initial_hits), BigInt(expected));
  }
}
```

Use the admin client to make one `last_seen_at` older than 60 seconds, assert host next-round RPC is rejected, touch that participant, and assert the retry succeeds. Assert an authenticated observer cannot touch, close, leave, or expire the room.

- [ ] **Step 4: Verify leave and idle expiry in separate rooms**

In a two-player active room, call `leave_game_room` as guest. Assert status `closed`, member count zero, and any settled results/obligations remain. In another active room, set `updated_at` older than two minutes via admin, call `expire_idle_game_room` concurrently from both members, and assert idempotent success and zero memberships.

- [ ] **Step 5: Run and commit QA contracts**

Run: `node --test tests/live-authority-qa.test.mjs tests/live-authority-cleanup.test.mjs`

Expected: PASS.

```powershell
git add scripts/live-authority-qa.mjs tests/live-authority-qa.test.mjs
git commit -m "Prove lifecycle authority with disposable real accounts" -m "The live harness covers four-player presence, frozen fold debts, stale participants, leave closure, idle expiry, and cleanup." -m "Constraint: QA leaves no auth users, rooms, results, or obligations" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: live QA source and cleanup contracts"
```

### Task 7: Apply and verify Supabase remotely

**Files:**
- Modify: `src/lib/supabase/database.types.ts` only if generated types differ
- Modify: `progress.md`

- [ ] **Step 1: Load the required Supabase skill**

Read `C:/Users/js100/.codex/plugins/cache/openai-curated-remote/supabase/1.0.0/skills/supabase/SKILL.md` completely. Follow its project-selection, migration, advisor, and verification sequence for project `cjgzebobocbntgkhhvvh`. Never print or commit database/service-role credentials.

- [ ] **Step 2: Compile in a rollback transaction**

Execute the migration inside `begin; ... rollback;`, then inspect `pg_proc`, `pg_constraint`, `pg_indexes`, and `cron.job` before rollback.

Expected: all functions compile; action checks include fold; presence index exists; exactly one pending cron job name is valid inside the transaction; rollback leaves no persistent schema change.

- [ ] **Step 3: Apply once and compare generated types**

Apply the migration through Supabase migration tooling and verify one history row. Generate types without overwriting the working file:

```powershell
npx supabase gen types typescript --project-id cjgzebobocbntgkhhvvh --schema public > $env:TEMP\ddakbam-database.types.ts
```

Compare only `room_members` and `Functions`, then use `apply_patch` for any schema-derived difference. Expected: `last_seen_at` and all four RPCs match.

- [ ] **Step 4: Run real disposable-account QA**

Load existing local secrets without echoing them and run:

```powershell
node scripts/live-authority-qa.mjs
```

Expected: all scenarios pass and cleanup reports zero disposable auth/profile/room/result/obligation rows.

- [ ] **Step 5: Run advisors and record evidence**

Run Supabase security and performance advisors. Require no new RLS, mutable-search-path, exposed-function, or missing-index warning from this migration. Record migration ID, live QA, cleanup counts, cron job, and advisor results in `progress.md` without credentials.

- [ ] **Step 6: Commit remote evidence**

```powershell
git add src/lib/supabase/database.types.ts progress.md
git commit -m "Record the verified online lifecycle deployment" -m "Remote types, disposable-account QA, scheduled expiry, cleanup, and advisor checks match the repository contract." -m "Constraint: Production credentials stay outside source control" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: rollback compile, live authority QA, Supabase advisors"
```

### Task 8: Perform visual and browser gameplay verification

**Files:**
- Modify: `src/components/online-room-game.tsx` only for a reproduced defect
- Modify: `src/app/globals.css` only for a reproduced defect
- Modify: `.omx/state/dedicated-game/ralph-progress.json`
- Modify: `progress.md`

- [ ] **Step 1: Load required game and visual skills**

Read `C:/Users/js100/.codex/skills/develop-web-game/SKILL.md` and `C:/Users/js100/.codex/skills/visual-verdict/SKILL.md` completely. Start the app on an available localhost port, use the required Playwright game client and `window.render_game_to_text`, and persist every visual-verdict iteration to `.omx/state/dedicated-game/ralph-progress.json`.

- [ ] **Step 2: Verify 1280×720 four-player play**

Use four browser contexts with disposable accounts. Verify lobby/account stats disappear during play; local cards are approximately 132×194; opponent cards are approximately 76×112; four seats, status, stake, fold/raise/call, ledger, and end controls are legible; hidden opponents show two backs before showdown; ranking rollup does not cover actions; console errors are zero.

- [ ] **Step 3: Verify lifecycle transitions**

Perform call, raise, and fold only on legal turns. Confirm folded seats are marked/skipped and cannot win. Stop one context’s heartbeat for 61 seconds and confirm the host’s next-round attempt is disabled/denied with `참가자 접속을 확인할 수 없어 다음 판을 시작할 수 없어요.` Resume it, touch presence, and start the next round. Make a non-host leave and confirm every context returns to game main.

For the two-minute path, use the admin test setup to backdate `updated_at` instead of waiting. Confirm the next 10-second poll returns all contexts with the idle message.

- [ ] **Step 4: Verify 390×844 mobile play**

Verify local cards approximately 96×142; opponents use no more than two columns; action dock remains reachable; all controls are at least 44px; ranking list scrolls internally; ledger modal opens/closes; document horizontal overflow is zero.

- [ ] **Step 5: Run visual verdict every iteration**

Require score ≥90 and no critical hierarchy, legibility, overlap, clipping, contrast, responsive-flow, or state-clarity issue. For each defect, make one focused edit, rerun focused tests and screenshot, update the verdict JSON, and repeat.

- [ ] **Step 6: Record and commit visual evidence**

Add dimensions, transitions, console count, verdict score, and screenshot paths to `progress.md`.

```powershell
git add src/components/online-room-game.tsx src/app/globals.css .omx/state/dedicated-game/ralph-progress.json progress.md
git commit -m "Keep the dedicated table readable across real game states" -m "Desktop and mobile browser checks capture verified gameplay and lifecycle transitions." -m "Constraint: Cards and actions remain usable at 390 by 844" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: Playwright game flow, text render, console inspection, visual verdict"
```

If no source correction is needed, stage only verification evidence and the state file.

### Task 9: Final gate, GitHub push, and Vercel production deployment

**Files:**
- Modify: `progress.md`

- [ ] **Step 1: Run the complete local gate**

Run sequentially:

```powershell
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: all existing and new tests pass; lint/typecheck/build exit 0; diff check is empty; status contains only intentional uncommitted evidence, if any.

- [ ] **Step 2: Recheck trust boundaries and secrets**

```powershell
rg -n 'from\("game_rooms"\).*update|from\("game_results"\).*insert|from\("hit_obligations"\).*insert' src
rg -n 'service_role|SUPABASE_SERVICE_ROLE_KEY|2S/k@' . -g '!node_modules/**' -g '!.next/**' -g '!.git/**'
```

Expected: no browser-authoritative game write and no committed credential. Confirm the migration never deletes `game_results`/`hit_obligations` and each new RPC grants execute only to authenticated.

- [ ] **Step 3: Commit final evidence when changed**

```powershell
git add progress.md
git commit -m "Close the online lifecycle verification record" -m "The repository records full tests, checks, build, live database, and browser evidence." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm test, lint, typecheck, build, diff check"
```

- [ ] **Step 4: Push the requested repository**

Verify origin is `https://github.com/jsk1004ha/ddakbamonline.git`, then:

```powershell
git push origin main
```

Expected: local `main` matches `origin/main`.

- [ ] **Step 5: Load Vercel deployment guidance and deploy**

Read `C:/Users/js100/.codex/plugins/cache/openai-curated-remote/vercel/1.0.0/skills/deployments-cicd/SKILL.md` completely. Deploy the pushed commit to project `prj_RvtK9QTIBe4gWfmc91mh5D21tCpT` in team `team_d6Z4QGlWo03bHEKNInhAceUU` while preserving existing Supabase environment variables.

Expected: deployment is Ready and `https://ddakbamonline-live.vercel.app/` resolves to the new commit.

- [ ] **Step 6: Production smoke test and cleanup**

At the production alias, use disposable accounts to start a two-player game, verify large cards and fold, end the game, and confirm both return to main. Inspect browser console and Vercel logs, remove disposable data, and add deployment URL/commit/smoke evidence to `progress.md`. Commit and push that evidence only if the file changed.

## Plan self-review result

- Spec coverage: dedicated same-page mode, larger cards, fold rules, per-player frozen debt, tie behavior, 20-second heartbeat, 60-second presence, next-round blocking, two-minute idle close, one-minute server schedule, leave/end behavior, return to main, authority, responsive UI, remote QA, push, and deployment are each assigned.
- Placeholder scan: no deferred implementation markers or unspecified error-handling steps remain.
- Type consistency: the four RPC names, `last_seen_at`, `foldedPlayerIds`, and `foldedStakes` are identical in SQL, runtime parser, declarations, React, and tests.
- Remaining deployment risk: `pg_cron` availability is verified before apply; the 10-second authenticated expiry poll remains the client recovery path, but Task 7 must not claim abandoned-room cleanup if the scheduled job cannot be enabled.


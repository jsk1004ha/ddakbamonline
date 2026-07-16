import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
  name.endsWith("_add_game_lifecycle_and_fold.sql"),
);

test("game lifecycle is defined by exactly one generated migration", () => {
  assert.equal(
    migrationNames.length,
    1,
    `expected one lifecycle migration, found ${migrationNames.length}`,
  );
});

const sql =
  migrationNames.length === 1
    ? await readFile(new URL(migrationNames[0], migrationsDirectory), "utf8")
    : "";

function functionBody(qualifiedName) {
  const escapedName = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(
    new RegExp(
      `create or replace function ${escapedName}\\b[\\s\\S]*?\\bas \\$function\\$([\\s\\S]*?)\\$function\\$;`,
      "i",
    ),
  );
  assert.ok(match, `missing ${qualifiedName}`);
  return match[1];
}

test("presence is server-owned and indexed without touching room activity", () => {
  assert.match(
    sql,
    /alter table public\.room_members\s+add column last_seen_at timestamptz not null default clock_timestamp\(\)/i,
  );
  assert.match(
    sql,
    /create index room_members_room_last_seen_at_idx\s+on public\.room_members \(room_id, last_seen_at desc\)/i,
  );
  assert.doesNotMatch(sql, /grant update\s*\([^)]*last_seen_at/i);

  const touch = functionBody("public.touch_room_presence");
  assert.match(touch, /caller_id uuid := auth\.uid\(\)/i);
  assert.match(touch, /update public\.room_members/i);
  assert.match(touch, /user_id = caller_id/i);
  assert.match(touch, /last_seen_at = clock_timestamp\(\)/i);
  assert.doesNotMatch(touch, /update public\.game_rooms/i);
});

test("fold is accepted by storage and freezes public folded commitments", () => {
  assert.match(sql, /drop constraint game_actions_action_name_check/i);
  assert.match(sql, /drop constraint game_actions_raise_shape_check/i);
  assert.match(sql, /action_name in \('call', 'raise', 'fold'\)/i);
  assert.match(
    sql,
    /action_name in \('call', 'fold'\) and raise_to is null/i,
  );

  const action = functionBody("public.play_game_action");
  assert.match(action, /action_name not in \('call', 'raise', 'fold'\)/i);
  assert.match(action, /if action_name = 'fold'/i);
  assert.match(action, /folded_stakes := jsonb_set/i);
  assert.match(action, /private\.serialize_exact_integer\(current_stake\)/i);
  assert.match(action, /active_player_ids/i);
  assert.match(action, /candidate_id = any \(active_player_ids\)/i);
  assert.match(action, /case when action_name = 'raise' then next_stake else null end/i);
});

test("schema-2 public state has exact folding fields without hidden hands", () => {
  const builder = functionBody("private.build_public_round_state");
  for (const key of [
    "schema",
    "roundToken",
    "roundNumber",
    "playerIds",
    "foldedPlayerIds",
    "foldedStakes",
    "betting",
    "phase",
    "evaluations",
    "winnerIds",
  ]) {
    assert.match(builder, new RegExp(`'${key}'`, "i"));
  }
  assert.doesNotMatch(builder, /['"]hands['"]/i);
});

test("rolling patch canonicalizes missing, null, wrong-type, and mismatched fold fields", () => {
  const patch = sql.match(
    /update public\.game_rooms[\s\S]*?(?=drop function private\.build_public_round_state)/i,
  )?.[0];
  assert.ok(patch, "missing rolling schema-2 state patch");
  assert.match(patch, /'\{foldedPlayerIds\}',\s*'\[\]'::jsonb/is);
  assert.match(patch, /'\{foldedStakes\}',\s*'\{\}'::jsonb/is);
  assert.match(patch, /where state ->> 'schema' = '2';/i);
  assert.doesNotMatch(patch, /coalesce\s*\(/i);
  assert.doesNotMatch(patch, /state\s*->\s*'folded(?:PlayerIds|Stakes)'/i);
});

test("next round admission requires exact membership and fresh presence", () => {
  const start = functionBody("public.start_game_round");
  assert.match(start, /room_record\.status <> 'playing'/i);
  assert.match(start, /room_record\.state ->> 'phase' <> 'showdown'/i);
  assert.match(start, /previous_player_ids is distinct from player_ids/i);
  assert.match(start, /Round players no longer match room membership/i);
  assert.match(
    start,
    /last_seen_at < clock_timestamp\(\) - interval '60 seconds'/i,
  );
  assert.match(start, /Every player must be online/i);
  assert.match(start, /array\[\]::uuid\[\]/i);
  assert.match(start, /'\{\}'::jsonb/i);
});

test("action validation excludes folded players from active betting state", () => {
  const action = functionBody("public.play_game_action");
  assert.match(action, /folded_player_ids/i);
  assert.match(action, /folded_stakes/i);
  assert.match(action, /state_record -> 'evaluations' <> '\{\}'::jsonb/i);
  assert.match(action, /state_record -> 'winnerIds' <> '\[\]'::jsonb/i);
  assert.match(action, /jsonb_object_keys\(betting_record\).*betting_key/is);
  assert.match(action, /Unexpected betting state key/i);
  assert.match(
    action,
    /count\(\*\) from jsonb_object_keys\(betting_record\)\) <> 8/i,
  );
  assert.match(action, /Folded players must be in seat order/i);
  assert.match(action, /Folded stake keys do not match folded players/i);
  assert.match(action, /Folded players cannot remain pending/i);
  assert.match(action, /At least two active players must remain while betting/i);
  assert.match(action, /Pot does not equal commitments/i);
  assert.match(action, /cardinality\(active_player_ids\) = 1/i);
  assert.match(action, /winner_ids := array_append\(winner_ids, candidate_id\)/i);
  assert.match(
    action,
    /if candidate_id = any \(active_player_ids\)[\s\S]*best_rank/is,
  );
  assert.match(action, /initial_hits[\s\S]*frozen_stake/is);
});

test("lifecycle RPCs authenticate, lock room authority, and use server time", () => {
  for (const name of [
    "public.close_game_room",
    "public.leave_game_room",
    "public.expire_idle_game_room",
  ]) {
    const body = functionBody(name);
    assert.match(body, /auth\.uid\(\)/i, `${name} must authenticate`);
    assert.match(
      body,
      /from public\.game_rooms[\s\S]*for update/i,
      `${name} must lock game_rooms`,
    );
  }

  const expiry = functionBody("public.expire_idle_game_room");
  assert.match(
    expiry,
    /updated_at <= clock_timestamp\(\) - interval '2 minutes'/i,
  );
  assert.doesNotMatch(expiry, /client|input.*timestamp|target_time/i);
});

test("closed-room cleanup removes membership but preserves settlement history", () => {
  const memberDelete = functionBody("private.lock_waiting_room_member_delete");
  assert.match(memberDelete, /room_status not in \('waiting', 'closed'\)/i);

  const finish = functionBody("private.finish_game_room");
  assert.match(finish, /status = 'closed'/i);
  assert.match(finish, /state = '\{\}'::jsonb/i);
  assert.match(finish, /version = version \+ 1/i);
  assert.match(finish, /delete from public\.room_members/i);
  assert.doesNotMatch(finish, /delete from public\.(game_results|hit_obligations)/i);
});

test("close and leave are versioned, host-aware, and idempotent", () => {
  const close = functionBody("public.close_game_room");
  assert.match(close, /host_id <> caller_id/i);
  assert.match(close, /version <> expected_version/i);
  assert.match(close, /'closed', true/i);

  const leave = functionBody("public.leave_game_room");
  assert.match(leave, /version <> expected_version/i);
  assert.match(leave, /status = 'waiting'/i);
  assert.match(leave, /host_id = caller_id/i);
  assert.match(leave, /delete from public\.game_rooms/i);
  assert.match(leave, /perform private\.finish_game_room/i);
});

test("idle cleanup is skip-locked and scheduled once through pg_cron APIs", () => {
  assert.match(
    sql,
    /create extension if not exists pg_cron\s*;/i,
  );
  assert.doesNotMatch(
    sql,
    /create extension if not exists pg_cron\s+with schema/i,
  );
  const cleanup = functionBody("private.expire_idle_game_rooms");
  assert.match(cleanup, /status = 'playing'/i);
  assert.match(
    cleanup,
    /updated_at <= clock_timestamp\(\) - interval '2 minutes'/i,
  );
  assert.match(cleanup, /for update skip locked/i);
  assert.match(cleanup, /private\.finish_game_room/i);
  assert.match(sql, /cron\.unschedule/i);
  assert.match(
    sql,
    /cron\.schedule\(\s*'expire-idle-ddakbam-games',\s*'\*\/1 \* \* \* \*',\s*'select private\.expire_idle_game_rooms\(\);'/i,
  );
  assert.doesNotMatch(sql, /update\s+cron\.job/i);
});

test("all new functions pin search paths and expose lifecycle only to authenticated", () => {
  const functions = [
    "private.build_public_round_state",
    "private.lock_waiting_room_member_delete",
    "private.finish_game_room",
    "private.expire_idle_game_rooms",
    "public.start_game_round",
    "public.play_game_action",
    "public.touch_room_presence",
    "public.close_game_room",
    "public.leave_game_room",
    "public.expire_idle_game_room",
  ];
  for (const name of functions) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      sql,
      new RegExp(
        `create or replace function ${escapedName}\\b[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
        "i",
      ),
    );
  }

  for (const signature of [
    "public.touch_room_presence(uuid)",
    "public.close_game_room(uuid, bigint)",
    "public.leave_game_room(uuid, bigint)",
    "public.expire_idle_game_room(uuid)",
  ]) {
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      sql,
      new RegExp(
        `revoke all on function ${escapedSignature}\\s+from public, anon, authenticated`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `grant execute on function ${escapedSignature}\\s+to authenticated`,
        "i",
      ),
    );
  }

  for (const signature of [
    "private.finish_game_room(uuid)",
    "private.expire_idle_game_rooms()",
    "private.lock_waiting_room_member_delete()",
  ]) {
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      sql,
      new RegExp(
        `revoke all on function ${escapedSignature}\\s+from public, anon, authenticated`,
        "i",
      ),
    );
  }
  assert.doesNotMatch(sql, /grant execute on function private\./i);
});

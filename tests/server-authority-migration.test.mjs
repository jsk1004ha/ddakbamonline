import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
  name.endsWith("_server_authoritative_game.sql"),
);

test("server authority is defined by exactly one generated migration", () => {
  assert.equal(
    migrationNames.length,
    1,
    `expected one server-authority migration, found ${migrationNames.length}`,
  );
});

const sql =
  migrationNames.length === 1
    ? await readFile(new URL(migrationNames[0], migrationsDirectory), "utf8")
    : "";

test("migration adds account identity and protected round storage", () => {
  assert.match(sql, /add column account_id text/i);
  assert.match(sql, /create table public\.game_round_hands/i);
  assert.match(sql, /create table public\.game_actions/i);
  assert.match(sql, /alter table public\.game_round_hands enable row level security/i);
  assert.match(sql, /alter table public\.game_actions enable row level security/i);
  assert.match(sql, /account_id.*\^\[a-z0-9_\]\{4,20\}\$/is);
  assert.match(sql, /new\.email.*@accounts\\?\.ddakbam\\?\.invalid/is);
  assert.doesNotMatch(sql, /raw_user_meta_data\s*->>\s*['"]account_id['"]/i);
});

test("migration exposes only authenticated server-authority RPCs", () => {
  assert.match(sql, /create or replace function public\.start_game_round/i);
  assert.match(sql, /create or replace function public\.play_game_action/i);
  assert.match(sql, /create or replace function public\.record_physical_hit/i);

  for (const signature of [
    "public.start_game_round(uuid, bigint)",
    "public.play_game_action(uuid, bigint, text, text)",
    "public.record_physical_hit(uuid, numeric)",
  ]) {
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      sql,
      new RegExp(`revoke all on function ${escapedSignature}\\s+from public`, "i"),
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function ${escapedSignature}\\s+to authenticated`, "i"),
    );
  }

  assert.doesNotMatch(sql, /grant execute .* to anon/i);
});

test("all privileged functions pin an empty search path and hide private helpers", () => {
  const privilegedFunctions = [
    "private.ordered_room_players",
    "private.parse_exact_nonnegative_integer",
    "private.evaluate_seotda_hand",
    "public.start_game_round",
    "public.play_game_action",
    "public.record_physical_hit",
  ];

  for (const name of privilegedFunctions) {
    const escapedName = name.replace(".", "\\.");
    assert.match(
      sql,
      new RegExp(
        `create or replace function ${escapedName}[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''`,
        "i",
      ),
    );
  }

  assert.match(sql, /revoke all on all functions in schema private from public/i);
  assert.doesNotMatch(sql, /grant execute on function private\./i);
});

test("browser roles cannot mutate authoritative tables or room columns", () => {
  assert.match(
    sql,
    /revoke update \(status, state, version, updated_at\)\s+on public\.game_rooms/i,
  );
  assert.match(sql, /revoke insert on public\.game_rooms/i);
  assert.match(
    sql,
    /grant insert \(code, host_id, max_players\)\s+on public\.game_rooms/i,
  );
  assert.match(sql, /revoke insert on public\.game_results/i);
  assert.match(sql, /revoke insert, update on public\.hit_obligations/i);
  assert.match(sql, /revoke all on public\.game_round_hands/i);
  assert.match(sql, /revoke all on public\.game_actions/i);
  assert.doesNotMatch(sql, /grant .*game_round_hands.*insert/i);
  assert.doesNotMatch(sql, /grant .*game_actions.*insert/i);
});

test("RPC implementations lock authority rows and reject stale or unauthenticated calls", () => {
  assert.match(sql, /from public\.game_rooms[\s\S]*for update/is);
  assert.match(sql, /from public\.hit_obligations[\s\S]*for update/is);
  assert.match(sql, /caller_id uuid := auth\.uid\(\)/i);
  assert.match(sql, /caller_id is null/i);
  assert.match(sql, /room_record\.version <> expected_version/i);
  assert.match(sql, /obligation_record\.remaining_hits <> expected_remaining/i);
  assert.match(sql, /action_name not in \('call', 'raise'\)/i);
  assert.match(sql, /raise_to.*current_stake/is);
});

test("public room JSON remains card-free and settlement is duplicate-safe", () => {
  assert.match(sql, /jsonb_build_object\(\s*'schema',\s*2/i);
  assert.doesNotMatch(sql, /jsonb_build_object\([\s\S]{0,1500}'hands'/i);
  assert.match(sql, /on conflict \(round_token\) do nothing/i);
  assert.match(
    sql,
    /on conflict \(game_result_id, debtor_id, creditor_id\) do nothing/i,
  );
  assert.match(sql, /update public\.game_rooms[\s\S]*version = room_record\.version \+ 1/is);
});

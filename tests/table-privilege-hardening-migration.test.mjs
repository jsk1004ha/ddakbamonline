import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260715064500_lock_table_privileges.sql",
  import.meta.url,
);

test("public game tables expose only the client operations the UI needs", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const table of [
    "profiles",
    "game_rooms",
    "room_members",
    "game_results",
    "hit_obligations",
    "game_round_hands",
    "game_actions",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `revoke all privileges on table public\\.${table}\\s+from anon, authenticated`,
        "i",
      ),
    );
  }

  assert.match(sql, /grant select on table public\.profiles to authenticated/i);
  assert.match(
    sql,
    /grant update \(display_name\) on table public\.profiles to authenticated/i,
  );
  assert.match(
    sql,
    /grant insert \(code, host_id, max_players\)[\s\S]*public\.game_rooms to authenticated/i,
  );
  assert.match(
    sql,
    /grant select, delete on table public\.game_rooms to authenticated/i,
  );
  assert.match(
    sql,
    /grant insert \(room_id, user_id, seat\)[\s\S]*public\.room_members to authenticated/i,
  );
  assert.match(
    sql,
    /grant update \(ready\) on table public\.room_members to authenticated/i,
  );
  assert.match(
    sql,
    /grant select on table\s+public\.game_results, public\.hit_obligations,[\s\S]*public\.game_round_hands, public\.game_actions\s+to authenticated/i,
  );
  assert.doesNotMatch(
    sql,
    /\bgrant\s+(insert|update)[^;]*on table public\.game_results/i,
  );
});

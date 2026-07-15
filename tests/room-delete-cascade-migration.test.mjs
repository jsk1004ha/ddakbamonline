import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260715062000_allow_cascade_room_member_cleanup.sql",
  import.meta.url,
);

test("room deletion permits member cascade while direct in-game removal stays blocked", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(
    sql,
    /create or replace function private\.lock_waiting_room_member_delete\(\)/i,
  );
  assert.match(
    sql,
    /select room\.status[\s\S]*into room_status[\s\S]*where room\.id = old\.room_id[\s\S]*for update/is,
  );
  assert.match(sql, /if not found then\s+return old/is);
  assert.match(
    sql,
    /if room_status <> 'waiting' then[\s\S]*raise exception/is,
  );
  assert.match(
    sql,
    /revoke all on function private\.lock_waiting_room_member_delete\(\)\s+from public, anon, authenticated/is,
  );
});

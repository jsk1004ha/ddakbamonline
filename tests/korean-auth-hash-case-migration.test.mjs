import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
  name.endsWith("_normalize_korean_auth_hash_case.sql"),
);

test("Auth email case normalization is corrected by exactly one migration", () => {
  assert.equal(migrationNames.length, 1);
});

const sql =
  migrationNames.length === 1
    ? await readFile(new URL(migrationNames[0], migrationsDirectory), "utf8")
    : "";

test("Korean identity hashes are lowercased before comparison with Auth email", () => {
  assert.match(sql, /create or replace function public\.handle_new_user\(\)/i);
  assert.match(
    sql,
    /expected_email_local_part := 'u-' \|\| lower\([\s\S]*?translate\([\s\S]*?extensions\.digest/i,
  );
  assert.match(sql, /email_local_part <> expected_email_local_part/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(
    sql,
    /revoke all on function public\.handle_new_user\(\) from public, anon, authenticated/i,
  );
});

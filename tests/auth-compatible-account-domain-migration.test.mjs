import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
  name.endsWith("_auth_compatible_account_domain.sql"),
);

test("auth-compatible account domain is defined by exactly one corrective migration", () => {
  assert.equal(
    migrationNames.length,
    1,
    `expected one auth-compatible-domain migration, found ${migrationNames.length}`,
  );
});

const sql =
  migrationNames.length === 1
    ? await readFile(new URL(migrationNames[0], migrationsDirectory), "utf8")
    : "";

test("corrective migration derives account IDs only from the accepted internal domain", () => {
  assert.match(sql, /create or replace function public\.handle_new_user\(\)/i);
  assert.match(
    sql,
    /new\.email[\s\S]*?\^\[a-z0-9_\]\{4,20\}@accounts\\\.ddakbamonline\\\.com\$/i,
  );
  assert.match(sql, /split_part\(lower\(new\.email\),\s*'@',\s*1\)/i);
  assert.doesNotMatch(sql, /raw_user_meta_data\s*->>\s*['"]account_id['"]/i);
});

test("corrective trigger function pins its search path and is not browser-callable", () => {
  assert.match(
    sql,
    /create or replace function public\.handle_new_user\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.handle_new_user\(\)\s+from public, anon, authenticated/i,
  );
});

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
  name.endsWith("_allow_korean_account_ids.sql"),
);

test("Korean account IDs are defined by exactly one migration", () => {
  assert.equal(migrationNames.length, 1);
});

const sql =
  migrationNames.length === 1
    ? await readFile(new URL(migrationNames[0], migrationsDirectory), "utf8")
    : "";

test("profile IDs accept only normalized Hangul, ASCII letters, numbers, and underscores", () => {
  assert.match(sql, /drop constraint profiles_account_id_format_check/i);
  assert.match(sql, /char_length\(account_id\) between 2 and 20/i);
  assert.match(sql, /account_id = normalize\(account_id, NFC\)/i);
  assert.match(sql, /account_id ~ '\^\[가-힣a-z0-9_\]\+\$'/i);
});

test("signup trigger preserves legacy ASCII IDs and verifies opaque Korean identities", () => {
  assert.match(sql, /create or replace function public\.handle_new_user\(\)/i);
  assert.match(sql, /raw_user_meta_data\s*->>\s*'account_id'/i);
  assert.match(sql, /normalize\([\s\S]*?NFC\)/i);
  assert.match(sql, /extensions\.digest\([\s\S]*?'sha256'\)/i);
  assert.match(sql, /translate\([\s\S]*?'\+\/'[\s\S]*?'-_'/i);
  assert.match(sql, /email_local_part = requested_account_id/i);
  assert.match(sql, /email_local_part <> expected_email_local_part/i);
  assert.match(sql, /raise exception 'Unsupported account identity'/i);
});

test("replacement trigger remains pinned and unavailable to browser roles", () => {
  assert.match(
    sql,
    /create or replace function public\.handle_new_user\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.handle_new_user\(\) from public, anon, authenticated/i,
  );
});

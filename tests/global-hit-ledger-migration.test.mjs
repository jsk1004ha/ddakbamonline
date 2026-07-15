import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const migrationName = (await readdir(migrationsUrl)).find((name) =>
  name.endsWith("_allow_authenticated_global_hit_ledger.sql"),
);

test("global hit ledger migration exists", () => {
  assert.ok(migrationName);
});

const sql = migrationName
  ? await readFile(new URL(migrationName, migrationsUrl), "utf8")
  : "";

test("authenticated accounts can read the whole ledger without opening writes", () => {
  assert.match(
    sql,
    /drop policy if exists "Obligation parties can read their account ledger"\s+on public\.hit_obligations/i,
  );
  assert.match(
    sql,
    /create policy "Authenticated accounts can read the global hit ledger"\s+on public\.hit_obligations for select\s+to authenticated\s+using \(true\)/i,
  );
  assert.doesNotMatch(sql, /\bto anon\b/i);
  assert.doesNotMatch(sql, /grant\s+(?:insert|update|delete)/i);
  assert.doesNotMatch(sql, /disable row level security/i);
});

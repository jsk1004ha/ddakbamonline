import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
  name.endsWith("_index_offline_obligation_creator.sql"),
);

test("generated migration adds only the offline creator covering index", async () => {
  assert.deepEqual(migrationNames, [
    "20260715124529_index_offline_obligation_creator.sql",
  ]);

  const migrationUrl = new URL(migrationNames[0], migrationsDirectory);
  const sql = (await readFile(migrationUrl, "utf8"))
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLowerCase();

  assert.equal(
    sql,
    "create index if not exists hit_obligations_created_by_idx on public.hit_obligations using btree (created_by);",
  );
});

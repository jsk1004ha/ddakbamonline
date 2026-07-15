import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/20260715031247_correct_hit_stat_direction.sql",
  import.meta.url,
);

test("physical hit statistics follow creditor to debtor direction", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(
    sql,
    /set hits_delivered = hits_delivered \+ 1\s+where id = new\.creditor_id;/,
  );
  assert.match(
    sql,
    /set hits_received = hits_received \+ 1\s+where id = new\.debtor_id;/,
  );
  assert.match(sql, /where obligation\.creditor_id = profile\.id/);
  assert.match(sql, /where obligation\.debtor_id = profile\.id/);
});

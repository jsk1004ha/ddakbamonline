import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260715103757_add_offline_hit_obligations.sql",
  import.meta.url,
);
const rawSql = await readFile(migrationUrl, "utf8");
const sql = rawSql
  .replace(/--.*$/gm, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\s+/g, " ")
  .trim();

const functionMatch = sql.match(
  /create or replace function public\.add_offline_hit_obligation\s*\(\s*counterparty_id uuid\s*,\s*direction text\s*,\s*hits text\s*\)\s*returns public\.hit_obligations\s*language plpgsql\s*security definer\s*set search_path\s*=\s*''\s*as \$\$([\s\S]*?)\$\$;/i,
);
const functionBody = functionMatch?.[1] ?? "";

test("offline obligations extend the shared ledger with exact provenance invariants", () => {
  assert.match(
    sql,
    /alter table public\.hit_obligations alter column game_result_id drop not null/i,
  );
  assert.match(sql, /add column source text not null default 'game'/i);
  assert.match(
    sql,
    /add column created_by uuid references public\.profiles\s*\(id\)/i,
  );
  assert.match(
    sql,
    /add constraint \w+ check \(\s*\(source = 'game' and game_result_id is not null and created_by is null\) or \(source = 'offline' and game_result_id is null and room_id is null and created_by is not null\)\s*\)/i,
  );
});

test("offline creation is an authenticated security-definer RPC with a blank search path", () => {
  assert.ok(
    functionMatch,
    "expected the exact RPC signature, row return type, and security settings",
  );
  assert.match(functionBody, /actor_id uuid/i);
  assert.match(functionBody, /actor_id := auth\.uid\(\)/i);
  assert.equal(
    functionBody.match(/actor_id\s*:=/gi)?.length,
    1,
    "actor_id must be assigned exactly once",
  );
  assert.equal(
    functionBody.match(/auth\.uid\(\)/gi)?.length,
    1,
    "the actor must be derived exactly once from auth.uid()",
  );
  assert.match(
    functionBody,
    /if actor_id is null then raise exception 'Authentication required'; end if;/i,
  );
});

test("offline creation validates the counterparty and canonical hit count before casting", () => {
  assert.match(
    functionBody,
    /if counterparty_id is null or counterparty_id = actor_id then raise exception 'Counterparty cannot be the same account'; end if;/i,
  );
  assert.match(
    functionBody,
    /if not exists \(select 1 from public\.profiles where id = counterparty_id\) then raise exception 'Counterparty account not found'; end if;/i,
  );
  assert.match(
    functionBody,
    /if hits is null or hits !~ '\^\[1-9\]\[0-9\]\*\$' then raise exception 'Hits must be a positive canonical integer'; end if;/i,
  );

  const validationOffset = functionBody.search(/hits !~ '\^\[1-9\]\[0-9\]\*\$'/i);
  const castOffset = functionBody.search(/hit_count := hits::numeric/i);

  assert.ok(validationOffset >= 0, "expected canonical hit validation");
  assert.ok(castOffset > validationOffset, "hits must be validated before casting");
});

test("offline creation accepts only the two directions and maps debtor and creditor", () => {
  assert.match(
    functionBody,
    /if direction = 'i_hit' then creditor := actor_id; debtor := counterparty_id; elsif direction = 'i_owe' then creditor := counterparty_id; debtor := actor_id; else raise exception 'Invalid offline obligation direction'; end if;/i,
  );
});

test("offline creation inserts a game-free row with actor provenance and returns it", () => {
  assert.match(
    functionBody,
    /insert into public\.hit_obligations \( game_result_id, room_id, debtor_id, creditor_id, initial_hits, remaining_hits, source, created_by \) values \( null, null, debtor, creditor, hit_count, hit_count, 'offline', actor_id \) returning \* into created;/i,
  );
  assert.match(functionBody, /return created; end;/i);
});

test("only authenticated callers receive execute and table inserts remain revoked", () => {
  const signature =
    "public\\.add_offline_hit_obligation\\s*\\(uuid\\s*,\\s*text\\s*,\\s*text\\s*\\)";

  assert.match(
    sql,
    new RegExp(
      `revoke all on function ${signature} from public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`,
      "i",
    ),
  );
  assert.match(
    sql,
    new RegExp(
      `grant execute on function ${signature} to authenticated\\s*;`,
      "i",
    ),
  );
  assert.doesNotMatch(
    sql,
    new RegExp(
      `grant execute on function ${signature} to (?:public|anon)\\b`,
      "i",
    ),
  );
  assert.doesNotMatch(
    sql,
    /grant\b[^;]*\binsert\b[^;]*\bon(?: table)? public\.hit_obligations/i,
  );
  assert.doesNotMatch(sql, /alter table public\.hit_obligations disable row level security/i);
  assert.doesNotMatch(sql, /drop policy\b[^;]*\bon public\.hit_obligations/i);
});

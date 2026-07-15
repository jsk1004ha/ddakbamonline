# ID Authentication and Server Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace email-facing authentication with account IDs and move all hidden cards, legal action checks, showdown settlement, and physical-hit updates behind authenticated Supabase database authority.

**Architecture:** The browser converts a validated account ID to an internal synthetic email only at the Supabase Auth boundary. Public round JSON contains betting and showdown metadata but never card IDs; a protected hand table exposes only the caller's hand before showdown. Transactional Postgres RPCs lock the room, validate `auth.uid()` and optimistic versions, mutate state, evaluate hands, and settle results atomically.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node test runner, Supabase Auth/Postgres/RLS/Realtime, Playwright web-game client, Vercel

---

## File map

- Create `src/lib/auth/account-id.ts`: validation, normalization, and synthetic-email conversion.
- Create `tests/account-id.test.mjs`: executable account-ID contract.
- Modify `src/components/account-auth-dialog.tsx`: ID-only form fields and copy.
- Modify `src/components/account-room-panel.tsx`: ID auth calls and RPC-backed room/hit actions.
- Create `src/lib/game/online-round.mjs`: parser and types for public schema-2 round state without cards.
- Create `src/lib/game/online-round.d.mts`: TypeScript declarations for the public round helper.
- Create `tests/online-round.test.mjs`: public-state privacy contract.
- Create a CLI-generated `supabase/migrations/*_server_authoritative_game.sql`: account IDs, protected hands, action log, private helpers, public RPCs, RLS, and direct-write revocations.
- Create `tests/server-authority-migration.test.mjs`: static migration guardrails.
- Modify `src/components/online-room-game.tsx`: visible-hand queries and RPC-only gameplay.
- Regenerate `src/lib/supabase/database.types.ts`: new columns, tables, and RPC signatures.
- Modify `README.md`: account-ID rules and server-authority security model.
- Modify `progress.md`: verification evidence and explicitly excluded anti-cheat scope.

### Task 1: Account-ID contract

**Files:**
- Create: `tests/account-id.test.mjs`
- Create: `src/lib/auth/account-id.ts`

- [ ] **Step 1: Write the failing account-ID tests**

Use the repository's TypeScript transpilation pattern so the Node test runner executes the real helper:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/auth/account-id.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { accountIdEmail, normalizeAccountId, validateAccountId } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("normalizes an account ID before authentication", () => {
  assert.equal(normalizeAccountId("  Player_01  "), "player_01");
});

test("accepts only four to twenty lowercase letters, numbers, and underscores", () => {
  assert.equal(validateAccountId("abcd"), true);
  assert.equal(validateAccountId("player_01"), true);
  for (const value of ["abc", "a".repeat(21), "한글id", "user-name", "user name"]) {
    assert.equal(validateAccountId(value), false);
  }
});

test("maps an account ID to the non-user-facing auth identifier", () => {
  assert.equal(accountIdEmail(" Player_01 "), "player_01@accounts.ddakbamonline.com");
  assert.throws(() => accountIdEmail("bad-id"), /아이디/);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test tests/account-id.test.mjs`

Expected: FAIL because `src/lib/auth/account-id.ts` does not exist.

- [ ] **Step 3: Implement the minimum helper**

```ts
export const ACCOUNT_ID_PATTERN = /^[a-z0-9_]{4,20}$/;
export const ACCOUNT_ID_DOMAIN = "accounts.ddakbamonline.com";

export function normalizeAccountId(value: string): string {
  return value.trim().toLowerCase();
}

export function validateAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(normalizeAccountId(value));
}

export function accountIdEmail(value: string): string {
  const accountId = normalizeAccountId(value);
  if (!validateAccountId(accountId)) {
    throw new Error("아이디는 영문 소문자, 숫자, 밑줄 4~20자로 입력해 주세요.");
  }
  return `${accountId}@${ACCOUNT_ID_DOMAIN}`;
}
```

- [ ] **Step 4: Run the focused and full tests**

Run: `node --test tests/account-id.test.mjs && npm test`

Expected: the focused tests pass and the full suite has no regression.

- [ ] **Step 5: Commit the account-ID contract**

Stage only the two files and use a Lore commit whose directive keeps the synthetic email inside the Auth boundary.

### Task 2: ID-only authentication UI

**Files:**
- Modify: `src/components/account-auth-dialog.tsx`
- Modify: `src/components/account-room-panel.tsx`
- Test: `tests/account-id.test.mjs`

- [ ] **Step 1: Extend the failing test with user-facing source guardrails**

Read both component sources and assert that `type="email"`, `autoComplete="email"`, `payload.email`, and the Korean word `이메일` are absent while `loginId` and `autoComplete="username"` are present.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/account-id.test.mjs`

Expected: FAIL on the existing email field and payload.

- [ ] **Step 3: Replace the auth payload and form state**

Use this payload and input contract:

```ts
export type AuthPayload = {
  mode: "signin" | "signup";
  loginId: string;
  password: string;
  displayName: string;
};
```

The input is a text field labeled `아이디`, with `minLength={4}`, `maxLength={20}`, `pattern="[A-Za-z0-9_]{4,20}"`, `autoCapitalize="none"`, `spellCheck={false}`, and `autoComplete="username"`. Increase the password minimum to 8.

- [ ] **Step 4: Route Supabase Auth through `accountIdEmail`**

In `handleAuth`, validate and normalize the ID, then call:

```ts
const email = accountIdEmail(payload.loginId);

await supabase.auth.signUp({
  email,
  password: payload.password,
  options: { data: { display_name: cleanName } },
});
```

or:

```ts
await supabase.auth.signInWithPassword({ email, password: payload.password });
```

Translate auth failures to `아이디 또는 비밀번호가 맞지 않아요.` and `이미 사용 중인 아이디예요.` without exposing the internal email.

- [ ] **Step 5: Run tests, lint, and typecheck**

Run: `node --test tests/account-id.test.mjs && npm run lint && npm run typecheck`

Expected: all pass and no email input remains in the two auth components.

- [ ] **Step 6: Commit the UI conversion**

Use a Lore commit that records the no-email user contract and lack of unauthenticated password recovery.

### Task 3: Public round privacy boundary

**Files:**
- Create: `tests/online-round.test.mjs`
- Create: `src/lib/game/online-round.mjs`
- Create: `src/lib/game/online-round.d.mts`

- [ ] **Step 1: Write the failing public-state parser tests**

The test must accept this state and reject schema 1 or any object containing a `hands` key:

```js
const safeRound = {
  schema: 2,
  roundToken: "00000000-0000-4000-8000-000000000001",
  roundNumber: 1,
  playerIds: ["a", "b"],
  betting: {
    playerIds: ["a", "b"],
    commitments: { a: 0, b: 0 },
    currentStake: 1,
    pot: 0,
    turnPlayerId: "a",
    lastAggressorId: null,
    status: "betting",
    pendingPlayerIds: ["a", "b"],
  },
  phase: "betting",
  evaluations: {},
  winnerIds: [],
};

assert.deepEqual(readPublicOnlineRound(safeRound), safeRound);
assert.equal(readPublicOnlineRound({ ...safeRound, schema: 1 }), null);
assert.equal(readPublicOnlineRound({ ...safeRound, hands: { a: [] } }), null);
assert.equal(JSON.stringify(safeRound).includes("imageId"), false);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test tests/online-round.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement a strict parser and declarations**

Export `readPublicOnlineRound(value)` and a `PublicOnlineRoundState` declaration with schema `2`, no `hands`, and showdown-only `evaluations`/`winnerIds`. Reject unexpected `hands` even if all other fields look valid.

- [ ] **Step 4: Run focused and engine tests**

Run: `node --test tests/online-round.test.mjs tests/game-engine.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the privacy boundary**

The Lore directive must say that card IDs never belong in `game_rooms.state`.

### Task 4: Server-authoritative database migration

**Files:**
- Create: `tests/server-authority-migration.test.mjs`
- Create via CLI: `supabase/migrations/*_server_authoritative_game.sql`

- [ ] **Step 1: Write a failing migration contract test**

Find exactly one migration ending in `_server_authoritative_game.sql` and assert it contains:

```js
assert.match(sql, /add column account_id text/i);
assert.match(sql, /create table public\.game_round_hands/i);
assert.match(sql, /enable row level security/i);
assert.match(sql, /create table public\.game_actions/i);
assert.match(sql, /create or replace function public\.start_game_round/i);
assert.match(sql, /create or replace function public\.play_game_action/i);
assert.match(sql, /create or replace function public\.record_physical_hit/i);
assert.match(sql, /revoke update \(status, state, version, updated_at\)/i);
assert.match(sql, /revoke insert on public\.game_results/i);
assert.match(sql, /revoke insert, update on public\.hit_obligations/i);
assert.doesNotMatch(sql, /grant .*game_round_hands.*insert/i);
```

- [ ] **Step 2: Run the contract test and confirm RED**

Run: `node --test tests/server-authority-migration.test.mjs`

Expected: FAIL because no server-authority migration exists.

- [ ] **Step 3: Discover and create the migration with the CLI**

Run:

```powershell
npx -y supabase migration --help
npx -y supabase migration new server_authoritative_game
```

Use the exact path printed by the second command for all remaining steps.

- [ ] **Step 4: Add account identity and protected tables**

The migration must:

- add unique `profiles.account_id` with `^[a-z0-9_]{4,20}$` constraint;
- replace `handle_new_user()` so only `@accounts.ddakbamonline.com` identities create profiles and `account_id` derives from `auth.users.email` rather than metadata;
- create `game_round_hands` with a two-card range/uniqueness check and RLS;
- create append-only `game_actions` with RLS read access for room members;
- grant explicit select-only access and add policy indexes.

The hand policy must be equivalent to:

```sql
using (
  player_id = (select auth.uid())
  or (
    private.is_room_member(room_id)
    and exists (
      select 1 from public.game_rooms room
      where room.id = room_id
        and room.state ->> 'roundToken' = round_token::text
        and room.state ->> 'phase' = 'showdown'
    )
  )
)
```

- [ ] **Step 5: Add private card and state helpers**

Implement private helpers for ordered members, exact nonnegative integer parsing, card evaluation matching `engine.mjs`, and schema-2 public state construction. All use `security definer set search_path = ''`, have `PUBLIC` execution revoked, and are callable only by other privileged functions.

- [ ] **Step 6: Add `start_game_round`**

The public RPC must lock the room, validate `auth.uid()` is the host and the optimistic version matches, require 2–4 ready players for the first round, generate a unique shuffled deck server-side, insert two cards per player, write a card-free public state, and increment the room version once.

- [ ] **Step 7: Add `play_game_action`**

The public RPC must lock the room, validate membership/version/turn, accept only `call` or an integer `raise_to` greater than the current stake, compute the next public state, append one action log row, and increment the version. When all commitments match, it evaluates protected hands, marks showdown, inserts one `game_results` row for the round token, and inserts one directed obligation per loser only for a sole winner.

- [ ] **Step 8: Add `record_physical_hit` and revoke direct writes**

The RPC locks the obligation and validates creditor, expected remaining value, and positive remainder before decrementing one and incrementing delivered one. Revoke browser writes to authoritative room columns, results, obligations, hands, and actions; grant execute only on the three approved RPCs to `authenticated`.

- [ ] **Step 9: Run migration contract and SQL hygiene checks**

Run: `node --test tests/server-authority-migration.test.mjs && git diff --check`

Expected: PASS with no whitespace errors.

- [ ] **Step 10: Commit the database authority boundary**

Use a Lore commit with broad scope risk and a directive that all future game mutations go through authenticated RPCs.

### Task 5: RPC-only game client

**Files:**
- Modify: `src/components/account-room-panel.tsx`
- Modify: `src/components/online-room-game.tsx`
- Modify: `src/lib/supabase/database.types.ts`
- Test: `tests/online-round.test.mjs`

- [ ] **Step 1: Extend the failing source guardrails**

Assert that `online-room-game.tsx` no longer imports or calls `dealRound`, `applyAction`, `compareHands`, or writes `.from("game_rooms").update`, `.from("game_results").insert`, or `.from("hit_obligations").upsert`. Assert it contains `.rpc("play_game_action"` and reads `game_round_hands`.

- [ ] **Step 2: Run the guardrail test and confirm RED**

Run: `node --test tests/online-round.test.mjs`

Expected: FAIL on the current client-authoritative imports and writes.

- [ ] **Step 3: Regenerate database types after applying the migration to the target schema**

Use the Supabase type generation tool for project `cjgzebobocbntgkhhvvh`, review the output, and replace `src/lib/supabase/database.types.ts` through `apply_patch`.

- [ ] **Step 4: Route room start and next round through the start RPC**

Replace state creation and direct updates with:

```ts
await supabase.rpc("start_game_round", {
  target_room: room.id,
  expected_version: room.version,
});
```

Refresh the room after success and map stale-version errors to the existing synchronization notice.

- [ ] **Step 5: Load only RLS-visible hands**

When the public round token changes, query `game_round_hands` by room and round token. Store rows keyed by player ID. During betting RLS returns only the caller's row; during showdown it returns every current participant's row. Render two card backs for absent opponent rows.

- [ ] **Step 6: Route call and raise through the action RPC**

Call:

```ts
await supabase.rpc("play_game_action", {
  target_room: room.id,
  expected_version: room.version,
  action_name: action.type,
  raise_to: action.type === "raise" ? String(action.amount) : null,
});
```

Delete client-side showdown, result persistence, and obligation creation. Keep client validation only for immediate UX.

- [ ] **Step 7: Route physical hit recording through its RPC**

Replace direct obligation update with `record_physical_hit({ obligation_id, expected_remaining })`, then refresh the account ledger.

- [ ] **Step 8: Run focused tests, lint, typecheck, and build**

Run:

```powershell
node --test tests/online-round.test.mjs tests/account-id.test.mjs
npm run lint
npm run typecheck
npm run build
```

Expected: all pass; build renders `/` successfully.

- [ ] **Step 9: Commit the RPC-only client**

The Lore directive must forbid adding result or hand authority back to the React client.

### Task 6: Live Supabase security verification

**Files:**
- Modify: `supabase/config.toml`
- Modify: `progress.md`

- [ ] **Step 1: Check current CLI help and auth configuration path**

Run `npx -y supabase --help` and the relevant config command help. Ensure `auth.email.enable_confirmations = false` is applied to the linked hosted project without printing credentials.

- [ ] **Step 2: Apply the reviewed migration to project `cjgzebobocbntgkhhvvh`**

Use the Supabase migration tool with the exact committed SQL and migration name `server_authoritative_game`.

- [ ] **Step 3: Verify grants, policies, and functions with read-only SQL**

Query `information_schema.role_column_grants`, `routine_privileges`, `pg_policies`, and `pg_proc` to prove:

- authenticated cannot directly update authoritative room columns;
- authenticated cannot insert results or obligations;
- authenticated can execute only the intended public RPCs;
- hand RLS is enabled and no hand writes are granted;
- every security-definer function has an empty search path and no `PUBLIC` execute privilege.

- [ ] **Step 4: Run two-account adversarial integration scenarios**

Create ephemeral ID accounts and clean them up after testing. Verify before showdown that one account receives exactly its own hand and zero opponent card rows; direct room-state/result/obligation writes fail; out-of-turn, stale-version, invalid raise, and duplicate action RPC calls fail. Complete a round and verify showdown reveals all hands, one result is stored, and directed obligations are not duplicated.

- [ ] **Step 5: Run Supabase advisors**

Run both security and performance advisors. Fix security warnings introduced by this migration. Record informational unused-index notices without deleting indexes required for expected production queries.

- [ ] **Step 6: Append evidence to `progress.md` and commit**

Record the exact scenarios, advisor outcome, and excluded multi-account/collusion scope. Use a Lore commit with the tested live DB evidence.

### Task 7: Browser/game verification and release

**Files:**
- Modify: `README.md`
- Modify: `progress.md`

- [ ] **Step 1: Document the shipped model**

Update README with ID syntax, no-email login behavior, server-authoritative RPCs, hand visibility, and the explicit non-goals. Do not expose synthetic emails as a user-facing workflow or include any secret.

- [ ] **Step 2: Run the required web-game Playwright client**

Start the app, then use `C:\Users\js100\.codex\skills\develop-web-game\scripts\web_game_playwright_client.js` with short action bursts. Capture login/signup ID forms, a betting turn, and showdown. Inspect every generated screenshot and `render_game_to_text` output.

- [ ] **Step 3: Verify desktop and mobile interaction**

At 1280×720 and 390×844, verify ID form validation, dialog close/focus restoration, own-hand visibility, opponent card backs before showdown, all-hand reveal after showdown, call, raise, stale-state notice, ledger hit recording, and zero console errors.

- [ ] **Step 4: Run visual verdict**

Persist the verdict JSON under `.omx/state/id-auth-server-authority/ralph-progress.json`. Iterate until the visual score is at least 90 and status is pass.

- [ ] **Step 5: Run the final verification suite**

Run:

```powershell
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0 with no test, lint, type, build, or diff error.

- [ ] **Step 6: Commit documentation and final evidence**

Use a Lore commit listing browser, adversarial DB, static, and build verification, plus any remaining non-goals.

- [ ] **Step 7: Push and verify production**

Push `main` to `https://github.com/jsk1004ha/ddakbamonline.git`. Confirm the Vercel production deployment uses the pushed SHA, reaches `READY`, `https://ddakbamonline-live.vercel.app/` returns HTTP 200 with the ID UI, and recent runtime errors are empty.

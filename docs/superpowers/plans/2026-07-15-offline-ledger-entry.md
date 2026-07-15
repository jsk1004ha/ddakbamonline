# Offline Hit Ledger Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a real display name at signup and let a signed-in account add an immediate, name-selected offline hit debt to the shared account ledger.

**Architecture:** Extend `hit_obligations` with provenance instead of creating a second ledger. A single authenticated, server-authoritative RPC validates and creates offline obligations; the React ledger searches registered profiles by display name and invokes only that RPC. Client helpers provide fast validation, while PostgreSQL remains the authority for party mapping and arbitrary-precision hit counts.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node test runner, Supabase Auth/Postgres/RLS/Realtime, Playwright web-game client

---

## File map

- Create `src/lib/ledger/offline-entry.mjs`: pure name, quantity, and direction validation used by the browser.
- Create `src/lib/ledger/offline-entry.d.mts`: TypeScript declarations for the JavaScript helper.
- Create `tests/offline-entry.test.mjs`: real unit tests for validation and party direction.
- Create `tests/account-auth-name.test.mjs`: signup-name UI and normalization wiring regression test.
- Create `tests/offline-obligation-migration.test.mjs`: migration contract and authority-boundary regression tests.
- Create the timestamped migration using `supabase migration new add_offline_hit_obligations`; record the generated exact path before editing it.
- Modify `src/lib/supabase/database.types.ts`: add obligation provenance and the new RPC signature.
- Modify `src/components/account-auth-dialog.tsx`: label signup display name as `이름`.
- Modify `src/components/account-room-panel.tsx`: normalize names, search profiles, and call the offline-obligation RPC.
- Modify `src/components/hit-ledger-dialog.tsx`: add the name-driven offline entry form and source badges.
- Modify `tests/online-round.test.mjs`: ensure browser code uses the RPC and never directly inserts obligations.
- Modify `scripts/live-authority-qa.mjs`: prove live offline creation, immediate two-party visibility, and cleanup.
- Modify `tests/live-authority-qa.test.mjs`: require the live QA coverage.
- Modify `progress.md`: record implementation and verification evidence.

### Task 1: Client validation contract and signup name

**Files:**
- Create: `src/lib/ledger/offline-entry.mjs`
- Create: `src/lib/ledger/offline-entry.d.mts`
- Create: `tests/offline-entry.test.mjs`
- Modify: `src/components/account-auth-dialog.tsx`
- Modify: `src/components/account-room-panel.tsx`

- [ ] **Step 1: Write the failing helper tests**

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  mapOfflineParties,
  normalizeDisplayName,
  normalizeOfflineHits,
} from "../src/lib/ledger/offline-entry.mjs";

test("normalizes a required 2 to 24 character display name", () => {
  assert.equal(normalizeDisplayName("  홍길동  "), "홍길동");
  assert.throws(() => normalizeDisplayName(" A "), /이름은 2~24자/);
  assert.throws(() => normalizeDisplayName("가".repeat(25)), /이름은 2~24자/);
});

test("accepts only canonical positive arbitrary-precision hit counts", () => {
  assert.equal(normalizeOfflineHits("900719925474099300000"), "900719925474099300000");
  for (const value of ["", "0", "01", "-1", "1.5", " 2 "]) {
    assert.throws(() => normalizeOfflineHits(value), /1 이상의 정수/);
  }
});

test("maps the signed-in account to the requested obligation direction", () => {
  assert.deepEqual(mapOfflineParties("me", "other", "i_hit"), {
    creditorId: "me",
    debtorId: "other",
  });
  assert.deepEqual(mapOfflineParties("me", "other", "i_owe"), {
    creditorId: "other",
    debtorId: "me",
  });
  assert.throws(() => mapOfflineParties("me", "me", "i_hit"), /본인은 선택/);
  assert.throws(() => mapOfflineParties("me", "other", "bad"), /방향/);
});
```

Create `tests/account-auth-name.test.mjs` with this UI contract:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dialog = await readFile(
  new URL("../src/components/account-auth-dialog.tsx", import.meta.url),
  "utf8",
);
const panel = await readFile(
  new URL("../src/components/account-room-panel.tsx", import.meta.url),
  "utf8",
);

test("signup requires a display name labelled as a name", () => {
  assert.match(dialog, /mode === "signup"[\s\S]*이름[\s\S]*required/);
  assert.doesNotMatch(dialog, /닉네임/);
  assert.match(panel, /normalizeDisplayName\(payload\.displayName\)/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/offline-entry.test.mjs tests/account-auth-name.test.mjs`

Expected: FAIL because `src/lib/ledger/offline-entry.mjs` does not exist.

- [ ] **Step 3: Implement the minimal helper and declarations**

```js
export function normalizeDisplayName(value) {
  const normalized = String(value).trim();
  if (normalized.length < 2 || normalized.length > 24) {
    throw new Error("이름은 2~24자로 입력해 주세요.");
  }
  return normalized;
}

export function normalizeOfflineHits(value) {
  const normalized = String(value);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("딱밤 횟수는 1 이상의 정수로 입력해 주세요.");
  }
  return normalized;
}

export function mapOfflineParties(userId, counterpartyId, direction) {
  if (userId === counterpartyId) throw new Error("본인은 선택할 수 없어요.");
  if (direction === "i_hit") return { creditorId: userId, debtorId: counterpartyId };
  if (direction === "i_owe") return { creditorId: counterpartyId, debtorId: userId };
  throw new Error("딱밤 방향을 다시 선택해 주세요.");
}
```

```ts
export type OfflineDirection = "i_hit" | "i_owe";
export function normalizeDisplayName(value: unknown): string;
export function normalizeOfflineHits(value: unknown): string;
export function mapOfflineParties(
  userId: string,
  counterpartyId: string,
  direction: OfflineDirection,
): { creditorId: string; debtorId: string };
```

- [ ] **Step 4: Use the helper in signup and rename the label**

In `account-auth-dialog.tsx`, change only the visible signup label from `닉네임` to `이름` while retaining `required`, `minLength={2}`, `maxLength={24}`, and `autoComplete="nickname"`.

In `account-room-panel.tsx`, import `normalizeDisplayName`, replace the inline trim/length block with:

```ts
const cleanName = normalizeDisplayName(payload.displayName);
```

Change `authErrorMessage` so messages starting with `이름` pass through unchanged.

- [ ] **Step 5: Verify GREEN and commit**

Run: `node --test tests/offline-entry.test.mjs tests/account-auth-name.test.mjs && npm run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

Commit with a Lore message whose intent line is `Make account names explicit before they enter shared ledgers`, with `Tested: node --test tests/offline-entry.test.mjs tests/account-auth-name.test.mjs; npm run typecheck`.

### Task 2: Server-authoritative offline obligation migration

**Files:**
- Create: `tests/offline-obligation-migration.test.mjs`
- Create via CLI: the exact path printed by `supabase migration new add_offline_hit_obligations`

- [ ] **Step 1: Discover the CLI and generate the migration shell**

Run:

```powershell
supabase --version
supabase migration new --help
supabase migration new add_offline_hit_obligations
```

Expected: the CLI prints a new timestamped SQL path under `supabase/migrations/`. Use that exact path in the test and all subsequent commands.

- [ ] **Step 2: Write the failing migration contract test**

The test must read the generated file and assert all of these exact contracts:

```js
assert.match(sql, /alter table public\.hit_obligations[\s\S]*alter column game_result_id drop not null/i);
assert.match(sql, /add column source text not null default 'game'/i);
assert.match(sql, /add column created_by uuid[\s\S]*references public\.profiles \(id\)/i);
assert.match(sql, /source = 'game'[\s\S]*game_result_id is not null[\s\S]*created_by is null/is);
assert.match(sql, /source = 'offline'[\s\S]*game_result_id is null[\s\S]*created_by is not null/is);
assert.match(sql, /create or replace function public\.add_offline_hit_obligation/i);
assert.match(sql, /actor_id := auth\.uid\(\)/i);
assert.match(sql, /if actor_id is null then[\s\S]*Authentication required/is);
assert.match(sql, /if counterparty_id = actor_id then[\s\S]*cannot be the same account/is);
assert.match(sql, /hits !~ '\^\[1-9\]\[0-9\]\*\$'/i);
assert.match(sql, /set search_path = ''/i);
assert.match(sql, /revoke all on function public\.add_offline_hit_obligation\(uuid, text, text\)[\s\S]*from public, anon, authenticated/is);
assert.match(sql, /grant execute on function public\.add_offline_hit_obligation\(uuid, text, text\)[\s\S]*to authenticated/is);
```

- [ ] **Step 3: Run the test and verify RED**

Run: `node --test tests/offline-obligation-migration.test.mjs`

Expected: FAIL because the generated migration is empty.

- [ ] **Step 4: Implement the migration**

Use this complete function body after adding the three schema fields and the provenance check constraint described by the test:

```sql
create or replace function public.add_offline_hit_obligation(
  counterparty_id uuid,
  direction text,
  hits text
)
returns public.hit_obligations
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  debtor uuid;
  creditor uuid;
  hit_count numeric;
  created public.hit_obligations%rowtype;
begin
  actor_id := auth.uid();
  if actor_id is null then
    raise exception 'Authentication required';
  end if;
  if counterparty_id is null or counterparty_id = actor_id then
    raise exception 'Counterparty cannot be the same account';
  end if;
  if not exists (select 1 from public.profiles where id = counterparty_id) then
    raise exception 'Counterparty account not found';
  end if;
  if hits is null or hits !~ '^[1-9][0-9]*$' then
    raise exception 'Hits must be a positive canonical integer';
  end if;
  hit_count := hits::numeric;

  if direction = 'i_hit' then
    creditor := actor_id;
    debtor := counterparty_id;
  elsif direction = 'i_owe' then
    creditor := counterparty_id;
    debtor := actor_id;
  else
    raise exception 'Invalid offline obligation direction';
  end if;

  insert into public.hit_obligations (
    game_result_id, room_id, debtor_id, creditor_id,
    initial_hits, remaining_hits, source, created_by
  ) values (
    null, null, debtor, creditor,
    hit_count, hit_count, 'offline', actor_id
  ) returning * into created;

  return created;
end;
$$;

revoke all on function public.add_offline_hit_obligation(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.add_offline_hit_obligation(uuid, text, text)
  to authenticated;
```

The check constraint must accept only:

```sql
(source = 'game' and game_result_id is not null and created_by is null)
or
(source = 'offline' and game_result_id is null and room_id is null and created_by is not null)
```

- [ ] **Step 5: Verify GREEN and static security checks**

Run: `node --test tests/offline-obligation-migration.test.mjs tests/server-authority-migration.test.mjs tests/table-privilege-hardening-migration.test.mjs`

Expected: all migration tests pass; no direct INSERT grant is added for `authenticated`.

- [ ] **Step 6: Commit**

Commit with intent line `Allow offline debts without manufacturing game results`, trailers documenting the immediate-no-approval constraint, the rejected separate-table approach, and the focused migration tests.

### Task 3: Types and RPC-only client orchestration

**Files:**
- Modify: `src/lib/supabase/database.types.ts`
- Modify: `src/components/account-room-panel.tsx`
- Modify: `tests/online-round.test.mjs`

- [ ] **Step 1: Add failing source-boundary assertions**

Extend the existing authenticated RPC test with:

```js
assert.match(accountRoomSource, /\.rpc\("add_offline_hit_obligation"/);
assert.doesNotMatch(
  accountRoomSource,
  /\.from\("hit_obligations"\)[\s\S]{0,160}\.insert\(/,
);
assert.match(accountRoomSource, /\.ilike\("display_name"/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/online-round.test.mjs`

Expected: FAIL because the new RPC and display-name search do not exist in the client.

- [ ] **Step 3: Extend generated-style database types**

Add to every `hit_obligations` Row/Insert/Update shape:

```ts
source: "game" | "offline";
created_by: string | null;
```

Make `game_result_id` nullable in Row/Insert/Update and add:

```ts
add_offline_hit_obligation: {
  Args: {
    counterparty_id: string;
    direction: "i_hit" | "i_owe";
    hits: string;
  };
  Returns: Database["public"]["Tables"]["hit_obligations"]["Row"];
};
```

Add the `hit_obligations_created_by_fkey` relationship from `created_by` to `profiles.id` so the handwritten generated-style types match the live schema.

- [ ] **Step 4: Add profile search and RPC callbacks**

In `account-room-panel.tsx`, define:

```ts
async function searchProfilesByName(query: string): Promise<Profile[]> {
  if (!supabase || !user) return [];
  const normalized = query.trim();
  if (normalized.length < 2) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .ilike("display_name", `%${normalized}%`)
    .neq("id", user.id)
    .order("display_name")
    .limit(8);
  if (error) throw error;
  return data ?? [];
}

async function addOfflineObligation(input: {
  counterpartyId: string;
  direction: "i_hit" | "i_owe";
  hits: string;
}): Promise<void> {
  if (!supabase || !user) return;
  const hits = normalizeOfflineHits(input.hits);
  setLedgerBusy(true);
  setLedgerError("");
  try {
    const { error } = await supabase.rpc("add_offline_hit_obligation", {
      counterparty_id: input.counterpartyId,
      direction: input.direction,
      hits,
    });
    if (error) throw error;
    await refreshAccount(user.id);
  } catch (error) {
    setLedgerError(errorMessage(error));
    throw error;
  } finally {
    setLedgerBusy(false);
  }
}
```

Pass these functions to `HitLedgerDialog` as `onSearchProfiles` and `onAddOfflineObligation`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `node --test tests/online-round.test.mjs && npm run typecheck`

Expected: focused tests and TypeScript pass.

Commit with intent line `Keep manual ledger writes behind one authenticated RPC`.

### Task 4: Name-driven ledger form and source badges

**Files:**
- Modify: `src/components/hit-ledger-dialog.tsx`
- Create: `tests/ledger-dialog-ui.test.mjs`

- [ ] **Step 1: Write failing UI contract tests**

Read the dialog source and assert:

```js
assert.match(source, /오프라인 빚 추가/);
assert.match(source, /내가 때릴 딱밤/);
assert.match(source, /내가 맞을 딱밤/);
assert.match(source, /이름으로 계정 찾기/);
assert.match(source, /profile\.display_name/);
assert.match(source, /profile\.account_id/);
assert.match(source, /item\.source === "offline" \? "오프라인" : "게임"/);
assert.match(source, /onSearchProfiles/);
assert.match(source, /onAddOfflineObligation/);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/ledger-dialog-ui.test.mjs`

Expected: FAIL because the form and badges are absent.

- [ ] **Step 3: Implement the form state and interactions**

Add these props:

```ts
onSearchProfiles: (query: string) => Promise<Profile[]>;
onAddOfflineObligation: (input: {
  counterpartyId: string;
  direction: "i_hit" | "i_owe";
  hits: string;
}) => Promise<void>;
```

Maintain local `direction`, `query`, `matches`, `selectedProfile`, `hits`, `searchBusy`, and `notice` state. The search button calls `onSearchProfiles(query)`, each result button selects a profile, and form submission calls:

```ts
await onAddOfflineObligation({
  counterpartyId: selectedProfile.id,
  direction,
  hits,
});
setQuery("");
setMatches([]);
setSelectedProfile(null);
setHits("");
setNotice("오프라인 딱밤 빚을 양쪽 장부에 추가했어요.");
```

The submit button is disabled while busy or until a profile and hit count are present. Search results render `profile.display_name` as the primary text and `@${profile.account_id}` as secondary text. Existing ledger rows render this badge before the direction copy:

```tsx
<span className={`ledger-dialog__source ledger-dialog__source--${item.source}`}>
  {item.source === "offline" ? "오프라인" : "게임"}
</span>
```

Add compact responsive styles so the form uses two columns on desktop and one on mobile, with 44px minimum button/input height.

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/ledger-dialog-ui.test.mjs && npm run lint && npm run typecheck`

Expected: UI contract, lint, and types pass.

Commit with intent line `Let players record offline debts by recognizable account names`.

### Task 5: Live Supabase proof and deployment

**Files:**
- Modify: `scripts/live-authority-qa.mjs`
- Modify: `tests/live-authority-qa.test.mjs`
- Modify: `progress.md`

- [ ] **Step 1: Add failing live-QA contract assertions**

Require the script to call `add_offline_hit_obligation`, read the created row as both parties, assert `source === "offline"`, assert `game_result_id === null`, compare profile game counters before and after, and reject a self-counterparty plus a noncanonical hit value.

- [ ] **Step 2: Run the static QA test and verify RED**

Run: `node --test tests/live-authority-qa.test.mjs`

Expected: FAIL because the live script lacks offline-obligation coverage.

- [ ] **Step 3: Extend the disposable-account live QA**

Before room creation, snapshot both profiles' `games_played` and `games_won`. Invoke the RPC as host with guest as counterparty and a large canonical hit string. Assert both clients can select the same obligation, the source/provenance fields are correct, and the game counters remain unchanged. Assert self-selection and `01` are rejected. Track the returned obligation ID and make `cleanupQaData()` delete that ID before deleting results, rooms, or disposable users, so foreign-key restrictions cannot leave QA accounts behind.

- [ ] **Step 4: Apply and verify the migration**

Run the migration against project `cjgzebobocbntgkhhvvh` using the Supabase migration tool, then verify with SQL:

```sql
select source, count(*)
from public.hit_obligations
group by source;
```

Run the security and performance advisors. The new authenticated `SECURITY DEFINER` warning is acceptable only because the RPC validates `auth.uid()`, counterparty existence, self-selection, direction, and canonical positive hits while exposing no arbitrary identifiers for either party.

- [ ] **Step 5: Run the full verification gate**

Run sequentially:

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

Expected: all tests pass, lint/typecheck exit 0, and Next.js produces the static `/` route.

- [ ] **Step 6: Run browser interaction verification**

Start the local app, use the required `develop-web-game` Playwright client, open signup and confirm `이름`, then open the ledger and exercise direction selection, name search, duplicate-name secondary ID display, selection, arbitrary-precision count entry, submission, source badge, and one-hit decrement. Capture and visually inspect desktop 1280×720 and mobile 390×844 screenshots, and check console errors.

- [ ] **Step 7: Update progress, review, commit, push, and confirm Vercel**

Append the feature, migration, tests, screenshots, and remaining no-approval risk to `progress.md`. Run an independent read-only security/code review. Commit remaining files with a Lore message, push `main`, wait for the Vercel deployment matching the final SHA to reach `READY`, and fetch `https://ddakbamonline-live.vercel.app/` expecting HTTP 200.

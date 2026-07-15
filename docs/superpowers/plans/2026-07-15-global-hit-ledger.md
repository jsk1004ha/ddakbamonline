# Global Hit Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every authenticated account able to read and search the full hit ledger by display name, while fixing `i_owe` entries so the returned obligation appears immediately without weakening write authority.

**Architecture:** Keep `hit_obligations` as the single source of truth and widen only its authenticated SELECT policy. Fetch the global ledger once per active account, subscribe to one unfiltered Realtime stream, and merge the row returned by `add_offline_hit_obligation` before reconciling with the server. Keep name filtering and ID-based merge logic in the existing pure ledger helper module so UI behavior is directly testable.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase Postgres/RLS/Realtime, `@supabase/supabase-js`, Node test runner, Playwright web-game client, Vercel.

---

## File map

- Create via `supabase migration new`: `supabase/migrations/*_allow_authenticated_global_hit_ledger.sql` — replace the party-only SELECT policy with authenticated global read access.
- Create: `tests/global-hit-ledger-migration.test.mjs` — migration security contract.
- Modify: `src/lib/ledger/offline-entry.mjs` — pure name filtering and ID-based obligation merge.
- Modify: `src/lib/ledger/offline-entry.d.mts` — public helper signatures.
- Modify: `tests/offline-entry.test.mjs` — helper behavior and edge cases.
- Modify: `src/components/account-room-panel.tsx` — global fetch/subscription and immediate RPC result merge.
- Modify: `tests/offline-ledger-client.test.mjs` — AST/source contracts for fetch, subscription, and mutation order.
- Modify: `src/components/hit-ledger-dialog.tsx` — global title, name-only account results, ledger search and counts.
- Modify: `tests/ledger-dialog-ui.test.mjs` — visible UI and accessibility contracts.
- Modify: `scripts/live-authority-qa.mjs` — third-party global read, `i_owe`, and unauthorized hit regression.
- Modify: `tests/live-authority-qa.test.mjs` — live script contract.
- Modify: `progress.md` — implementation and verification handoff.

### Task 1: Lock and implement the global RLS read contract

**Files:**
- Create: `tests/global-hit-ledger-migration.test.mjs`
- Create via CLI: `supabase/migrations/*_allow_authenticated_global_hit_ledger.sql`

- [ ] **Step 1: Write the failing migration contract test**

```js
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
```

- [ ] **Step 2: Run the targeted test and confirm it fails because the migration does not exist**

Run: `node --test tests/global-hit-ledger-migration.test.mjs`

Expected: FAIL at `global hit ledger migration exists`.

- [ ] **Step 3: Discover the current Supabase CLI commands and create the migration skeleton**

Run:

```powershell
supabase --version
supabase --help
supabase migration --help
supabase migration new allow_authenticated_global_hit_ledger
```

Expected: a new timestamped migration ending in `_allow_authenticated_global_hit_ledger.sql`.

- [ ] **Step 4: Put the minimal policy change in the CLI-generated file**

```sql
drop policy if exists "Obligation parties can read their account ledger"
  on public.hit_obligations;

create policy "Authenticated accounts can read the global hit ledger"
on public.hit_obligations for select
to authenticated
using (true);
```

- [ ] **Step 5: Run the migration contract test**

Run: `node --test tests/global-hit-ledger-migration.test.mjs`

Expected: 2 tests PASS.

- [ ] **Step 6: Commit the policy contract**

```powershell
git add tests/global-hit-ledger-migration.test.mjs supabase/migrations/*_allow_authenticated_global_hit_ledger.sql
git commit -m "Let signed-in players inspect the shared hit ledger" -m "Constraint: Anonymous reads and direct writes remain blocked" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: node --test tests/global-hit-ledger-migration.test.mjs"
```

### Task 2: Add pure filter and immediate-merge behavior

**Files:**
- Modify: `tests/offline-entry.test.mjs`
- Modify: `src/lib/ledger/offline-entry.mjs`
- Modify: `src/lib/ledger/offline-entry.d.mts`

- [ ] **Step 1: Add failing helper tests**

```js
import {
  filterObligationsByName,
  mergeObligationById,
} from "../src/lib/ledger/offline-entry.mjs";

const obligations = [
  { id: "old", creditor_id: "creditor", debtor_id: "debtor" },
  { id: "other", creditor_id: "other-creditor", debtor_id: "other-debtor" },
];
const names = {
  creditor: "민수",
  debtor: "영희",
  "other-creditor": "지수",
  "other-debtor": "철수",
};

test("filters global obligations by either display name", () => {
  assert.deepEqual(filterObligationsByName(obligations, names, " 민 "), [obligations[0]]);
  assert.deepEqual(filterObligationsByName(obligations, names, "영희"), [obligations[0]]);
  assert.deepEqual(filterObligationsByName(obligations, names, ""), obligations);
  assert.deepEqual(filterObligationsByName(obligations, names, "없음"), []);
});

test("merges an RPC obligation by id at the front", () => {
  const replacement = { ...obligations[0], remaining_hits: "3" };
  assert.deepEqual(mergeObligationById(obligations, replacement), [replacement, obligations[1]]);
  const created = { id: "new", creditor_id: "creditor", debtor_id: "debtor" };
  assert.deepEqual(mergeObligationById(obligations, created), [created, ...obligations]);
});
```

- [ ] **Step 2: Run the helper tests and confirm the exports are missing**

Run: `node --test tests/offline-entry.test.mjs`

Expected: FAIL because `filterObligationsByName` and `mergeObligationById` are not exported.

- [ ] **Step 3: Implement the pure helpers**

```js
export function filterObligationsByName(obligations, names, query) {
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  if (!normalizedQuery) return obligations;

  return obligations.filter((obligation) => {
    const creditorName = names[obligation.creditor_id] ?? "";
    const debtorName = names[obligation.debtor_id] ?? "";
    return [creditorName, debtorName].some((name) =>
      name.toLocaleLowerCase("ko-KR").includes(normalizedQuery),
    );
  });
}

export function mergeObligationById(obligations, incoming) {
  return [incoming, ...obligations.filter((item) => item.id !== incoming.id)];
}
```

- [ ] **Step 4: Declare generic structural types without importing browser code**

```ts
type NamedObligation = {
  id: string;
  creditor_id: string;
  debtor_id: string;
};

export function filterObligationsByName<T extends NamedObligation>(
  obligations: T[],
  names: Record<string, string>,
  query: string,
): T[];

export function mergeObligationById<T extends { id: string }>(
  obligations: T[],
  incoming: T,
): T[];
```

- [ ] **Step 5: Run unit and type checks**

Run: `node --test tests/offline-entry.test.mjs && npm run typecheck`

Expected: all targeted tests PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the helpers**

```powershell
git add src/lib/ledger/offline-entry.mjs src/lib/ledger/offline-entry.d.mts tests/offline-entry.test.mjs
git commit -m "Keep shared ledger filtering and reconciliation deterministic" -m "Constraint: Preserve exact obligation IDs and arbitrary-precision hit strings" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: node --test tests/offline-entry.test.mjs; npm run typecheck"
```

### Task 3: Fetch, subscribe, and reconcile the global ledger

**Files:**
- Modify: `tests/offline-ledger-client.test.mjs`
- Modify: `src/components/account-room-panel.tsx`

- [ ] **Step 1: Change the client contract tests to require a global query and one subscription**

```js
test("loads and subscribes to one authenticated global ledger", () => {
  const refresh = findFunction("refreshLedger");
  assert.ok(refresh);
  const text = refresh.getText(sourceFile);
  assert.match(text, /\.from\("hit_obligations"\)[\s\S]*\.select\("\*"\)[\s\S]*\.order\("created_at"/);
  assert.doesNotMatch(text, /\.or\(/);

  assert.equal(
    source.match(/table: "hit_obligations"/g)?.length,
    1,
  );
  assert.doesNotMatch(source, /table: "hit_obligations", filter:/);
});

test("merges the returned offline row before global reconciliation", () => {
  const addFunction = findFunction("addOfflineObligation");
  assert.ok(addFunction);
  const text = addFunction.getText(sourceFile);
  assert.match(text, /const \{ data, error \} = await client\.rpc\("add_offline_hit_obligation"/);
  assert.match(text, /setObligations\(\(current\) => mergeObligationById\(current, created\)\)/);
  assert.match(text, /await loadProfiles\(\[created\.debtor_id, created\.creditor_id\], scope\)/);
  assert.match(text, /await refreshLedger\(scope\)/);
  assert.ok(text.indexOf("mergeObligationById") < text.indexOf("await refreshLedger(scope)"));
  assert.doesNotMatch(text, /await refreshAccount\(actorId, scope\)/);
});
```

- [ ] **Step 2: Run the client test and confirm party filtering/current refresh behavior fails the new contract**

Run: `node --test tests/offline-ledger-client.test.mjs`

Expected: FAIL on `.or(...)`, two filtered subscriptions, ignored RPC data, and `refreshAccount`.

- [ ] **Step 3: Import and use `mergeObligationById`, then remove the account filter**

```ts
import {
  buildProfileSearchPattern,
  ledgerErrorMessage,
  mergeObligationById,
  normalizeDisplayName,
  normalizeOfflineHits,
} from "@/lib/ledger/offline-entry.mjs";

const refreshLedger = useCallback(
  async (scope?: AccountScope) => {
    if (!supabase) return;
    const { data, error } = await retryTransientJwtRequest(() =>
      supabase
        .from("hit_obligations")
        .select("*")
        .order("created_at", { ascending: false }),
    );
    if (scope && !isActiveAccount(scope)) return;
    if (error) throw error;
    const rows = data ?? [];
    setObligations(rows);
    await loadProfiles(
      rows.flatMap((item) => [item.debtor_id, item.creditor_id]),
      scope,
    );
  },
  [isActiveAccount, loadProfiles, supabase],
);
```

- [ ] **Step 4: Merge RPC data immediately and reconcile only the ledger**

```ts
const { data, error } = await client.rpc("add_offline_hit_obligation", {
  counterparty_id: input.counterpartyId,
  direction: input.direction,
  hits: normalizedHits,
});
if (error) throw new Error(ledgerErrorMessage(error));
if (!isCurrentMutation(operation)) return;
const created = Array.isArray(data) ? data[0] : data;
if (!created) throw new Error("등록된 딱밤 빚을 확인하지 못했어요.");
setObligations((current) => mergeObligationById(current, created));
await loadProfiles([created.debtor_id, created.creditor_id], scope);

try {
  await refreshLedger(scope);
} catch {
  if (isCurrentMutation(operation)) setLedgerError(LEDGER_REFRESH_WARNING);
  return;
}
```

- [ ] **Step 5: Replace the two user-filtered Realtime handlers with one global handler**

```ts
.on(
  "postgres_changes",
  { event: "*", schema: "public", table: "hit_obligations" },
  () => void refreshLedger(scope),
)
```

Also change `refreshAccount` to call `refreshLedger(scope)` and every remaining callback to the same signature.

- [ ] **Step 6: Run client, unit, and type checks**

Run: `node --test tests/offline-ledger-client.test.mjs tests/offline-entry.test.mjs && npm run typecheck`

Expected: all targeted tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit the global client flow**

```powershell
git add src/components/account-room-panel.tsx tests/offline-ledger-client.test.mjs
git commit -m "Make successful offline debts visible before reconciliation" -m "Constraint: Account-generation guards must reject stale async completions" -m "Rejected: Refresh the whole account | profile and room state are unrelated to a ledger write" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: client contract tests; unit tests; TypeScript"
```

### Task 4: Add name-only global ledger search UI

**Files:**
- Modify: `tests/ledger-dialog-ui.test.mjs`
- Modify: `src/components/hit-ledger-dialog.tsx`

- [ ] **Step 1: Replace the old account-ID expectation and add global search assertions**

```js
test("renders a searchable global ledger with names only", () => {
  assert.match(source, /<h2 id="ledger-dialog-title">전체 딱밤 장부<\/h2>/);
  assert.match(source, /id="global-ledger-query"/);
  assert.match(source, /placeholder="때릴 사람 또는 맞을 사람 이름"/);
  assert.match(source, /filterObligationsByName\(obligations, names, ledgerQuery\)/);
  assert.match(source, /visibleObligations\.length/);
  assert.match(source, /obligations\.length/);
  assert.match(source, /<b>\{profile\.display_name\}<\/b>/);
  assert.doesNotMatch(source, /@\{profile\.account_id\}/);
});
```

- [ ] **Step 2: Run the UI contract test and confirm the old title/ID and missing search fail**

Run: `node --test tests/ledger-dialog-ui.test.mjs`

Expected: FAIL on title, search input, filter call, and account ID removal.

- [ ] **Step 3: Add the ledger query state and filtered rows**

```ts
import {
  createOfflineEntryUiState,
  filterObligationsByName,
  ledgerErrorMessage,
  normalizeDisplayName,
  normalizeOfflineHits,
  reduceOfflineEntryUiState,
} from "@/lib/ledger/offline-entry.mjs";

const [ledgerQuery, setLedgerQuery] = useState("");
const visibleObligations = filterObligationsByName(
  obligations,
  names,
  ledgerQuery,
);
```

- [ ] **Step 4: Render the global title, search form, counts, and filtered list**

```tsx
<h2 id="ledger-dialog-title">전체 딱밤 장부</h2>

<div className="ledger-dialog__ledgerSearch">
  <label htmlFor="global-ledger-query">전체 장부 이름 검색</label>
  <input
    id="global-ledger-query"
    type="search"
    value={ledgerQuery}
    placeholder="때릴 사람 또는 맞을 사람 이름"
    autoComplete="off"
    onChange={(event) => setLedgerQuery(event.target.value)}
  />
</div>

<span>{visibleObligations.length} / {obligations.length}건</span>
```

Render `visibleObligations.map(...)`. When `obligations` is nonempty but `visibleObligations` is empty, show `검색한 이름과 일치하는 장부가 없어요.` Remove `<span>@{profile.account_id}</span>` from the account search button.

- [ ] **Step 5: Add focused search styling inside the existing component style block**

```css
.ledger-dialog__ledgerSearch {
  display: grid;
  gap: 6px;
}
.ledger-dialog__ledgerSearch label {
  color: #cdbb9a;
  font-size: 0.76rem;
  font-weight: 800;
}
.ledger-dialog__ledgerSearch input {
  min-height: 44px;
  width: 100%;
  border: 1px solid rgba(242, 196, 109, 0.26);
  border-radius: 10px;
  background: rgba(7, 9, 8, 0.72);
  color: #fff7e5;
  padding: 0 12px;
}
.ledger-dialog__ledgerSearch input:focus-visible {
  border-color: #f3c96b;
  outline: 2px solid rgba(243, 201, 107, 0.32);
  outline-offset: 2px;
}
```

- [ ] **Step 6: Run UI, type, and lint checks**

Run: `node --test tests/ledger-dialog-ui.test.mjs && npm run typecheck && npm run lint`

Expected: targeted tests PASS; TypeScript and ESLint exit 0.

- [ ] **Step 7: Commit the name-only search UI**

```powershell
git add src/components/hit-ledger-dialog.tsx tests/ledger-dialog-ui.test.mjs
git commit -m "Make the shared ledger readable without exposing account IDs" -m "Constraint: Duplicate display names remain visually indistinguishable by request" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: UI contracts; TypeScript; ESLint"
```

### Task 5: Extend live authority QA for third-party reads and `i_owe`

**Files:**
- Modify: `tests/live-authority-qa.test.mjs`
- Modify: `scripts/live-authority-qa.mjs`

- [ ] **Step 1: Add failing source-contract assertions**

```js
test("live QA covers global reads and i_owe authority", () => {
  assert.match(script, /const observer = client\(\)/);
  assert.match(script, /direction:\s*"i_owe"/);
  assert.match(script, /readObligation\(observer, iOweObligation\.id\)/);
  assert.match(script, /observer\.rpc\(\s*"record_physical_hit"/);
  assert.match(script, /globalLedgerVisibleToObserver: true/);
  assert.match(script, /iOweDirectionVerified: true/);
});
```

- [ ] **Step 2: Run the contract and confirm the third account is missing**

Run: `node --test tests/live-authority-qa.test.mjs`

Expected: FAIL on observer and `i_owe` assertions.

- [ ] **Step 3: Provision and sign in a third observer account**

```js
const observer = client();

const observerAccountId = `qa_observer_${Date.now()}`;
const provisionedObserverId = await provisionQaUser(observerAccountId);
const observerId = await signIn(observer, observerAccountId);
assert.equal(observerId, provisionedObserverId);
```

- [ ] **Step 4: Create and verify the `i_owe` row through all three clients**

```js
const { data: iOweRpcData, error: iOweRpcError } = await host.rpc(
  "add_offline_hit_obligation",
  { counterparty_id: guestId, direction: "i_owe", hits: "3" },
);
assert.ifError(iOweRpcError);
const iOweObligation = Array.isArray(iOweRpcData) ? iOweRpcData[0] : iOweRpcData;
assert.ok(iOweObligation?.id);
offlineObligationIds.push(iOweObligation.id);
assert.equal(iOweObligation.debtor_id, hostId);
assert.equal(iOweObligation.creditor_id, guestId);
assert.equal((await readObligation(host, iOweObligation.id)).id, iOweObligation.id);
assert.equal((await readObligation(guest, iOweObligation.id)).id, iOweObligation.id);
assert.equal((await readObligation(observer, iOweObligation.id)).id, iOweObligation.id);
expectError(
  await observer.rpc("record_physical_hit", {
    obligation_id: iOweObligation.id,
    expected_remaining: "3",
  }),
  "third-party hit recording",
);
```

- [ ] **Step 5: Run the source contract**

Run: `node --test tests/live-authority-qa.test.mjs`

Expected: all live-script contract tests PASS.

- [ ] **Step 6: Commit the reproducible authority regression**

```powershell
git add scripts/live-authority-qa.mjs tests/live-authority-qa.test.mjs
git commit -m "Keep global visibility from becoming global authority" -m "Constraint: Disposable live accounts and obligations must always be cleaned" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: node --test tests/live-authority-qa.test.mjs" -m "Not-tested: Remote execution waits for the policy migration"
```

### Task 6: Apply Supabase changes and verify the complete product

**Files:**
- Modify: `progress.md`

- [ ] **Step 1: Check current Supabase guidance before applying**

Fetch `https://supabase.com/changelog.md`, scan relevant breaking changes, and use Supabase documentation search for RLS `TO authenticated`, Postgres Changes with RLS, and policy inspection. Do not change the `@supabase/supabase-js` pin.

- [ ] **Step 2: Apply the finalized SQL to project `cjgzebobocbntgkhhvvh` and inspect it**

Use Supabase `execute_sql` with the exact migration SQL, then query `pg_policies`, `information_schema.role_table_grants`, and `pg_class.relrowsecurity`.

Expected:

```text
Authenticated accounts can read the global hit ledger | SELECT | authenticated | true
authenticated has SELECT but no INSERT/UPDATE/DELETE on hit_obligations
anon has no table grant on hit_obligations
relrowsecurity = true
```

- [ ] **Step 3: Run Supabase advisors and migration bookkeeping checks**

Run the available Supabase advisors, then:

```powershell
supabase migration list --local
```

Expected: no new security/performance regression attributable to this migration; the new local migration is listed.

- [ ] **Step 4: Run the disposable three-account live QA**

Load the existing local environment values plus service-role test credentials and run:

```powershell
node scripts/live-authority-qa.mjs
```

Expected JSON includes:

```json
{
  "globalLedgerVisibleToObserver": true,
  "iOweDirectionVerified": true,
  "thirdPartyHitRejected": true
}
```

Verify cleanup reports no remaining disposable users or obligations.

- [ ] **Step 5: Run the full local verification suite**

Run:

```powershell
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Append implementation and verification evidence to `progress.md`**

```markdown
## 전체 딱밤 장부

- 인증 사용자의 전체 `hit_obligations` 조회 정책을 추가하고 익명 접근과 직접 쓰기 차단은 유지했다.
- 장부를 양쪽 표시 이름으로 검색하며 계정 검색 결과의 아이디 표시는 제거했다.
- `i_owe` RPC 반환 행을 즉시 병합한 뒤 서버와 재동기화하도록 변경했다.
- 제3자 조회, 제3자 차감 거부, `i_owe` 방향과 일회성 데이터 정리를 라이브 QA로 검증했다.
- 전체 테스트, ESLint, TypeScript, 프로덕션 빌드, 브라우저 시각 검증을 통과했다.
```

- [ ] **Step 7: Run the required Playwright web-game client and inspect screenshots**

Start the app, then use:

```powershell
node "$env:USERPROFILE\.codex\skills\develop-web-game\scripts\web_game_playwright_client.js" --url http://localhost:3000 --actions-json '{"steps":[{"buttons":[],"frames":2}]}' --click-selector ".accountRoom__ledgerTrigger" --iterations 1 --pause-ms 300
```

Inspect the latest desktop screenshot with the image viewer, verify `전체 딱밤 장부`, name-only account results, global search and counts. Repeat at a mobile viewport through browser automation, exercise `i_owe` submission, search the resulting names, refresh, and confirm persistence. Review console errors and fix the first new error before rerunning.

- [ ] **Step 8: Commit final verification notes and push**

```powershell
git add progress.md
git commit -m "Record proof that the shared ledger preserves authority" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: full test, lint, typecheck, build, live Supabase QA, desktop and mobile browser QA"
git push origin main
```

- [ ] **Step 9: Verify Vercel production**

Wait for the pushed deployment to reach READY, open `https://ddakbamonline-live.vercel.app`, verify HTTP 200 and no runtime console errors, and repeat the ledger smoke test against production.

Expected: global name search and `i_owe` persistence work in production.

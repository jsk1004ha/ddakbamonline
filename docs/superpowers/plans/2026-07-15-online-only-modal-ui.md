# Online-Only Modal UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the local AI experience, make Supabase multiplayer the only product flow, move authentication and the directed hit ledger into separate dialogs, and add a compact hand-name/ranking rollup.

**Architecture:** `AccountRoomPanel` becomes the page-level online shell and keeps ownership of Supabase session, room, member, and ledger state. Focused dialog components receive data and callbacks from that shell, while `OnlineRoomGame` gains a pure ranking-data helper and an accessible `<details>` rollup for the current account only.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase JS/Reatime, Node test runner, CSS, Vercel.

---

## File structure

- Create `src/lib/game/hand-ranking.mjs` — immutable compact ranking data and current-hand group lookup.
- Create `src/lib/game/hand-ranking.d.mts` — TypeScript declarations for the ranking helper.
- Create `tests/hand-ranking.test.mjs` — exact copy/order regression tests.
- Create `src/components/app-dialog.tsx` — shared native dialog lifecycle, backdrop, Escape, scroll lock, and focus restoration.
- Create `src/components/account-auth-dialog.tsx` — login/signup form and auth-only feedback.
- Create `src/components/hit-ledger-dialog.tsx` — account summaries, directed obligations, and hit-record controls.
- Modify `src/components/account-room-panel.tsx` — online app shell, dialog triggers, separated notices, and existing Supabase orchestration.
- Modify `src/components/online-room-game.tsx` — current-account hand name and compact ranking rollup.
- Modify `src/app/page.tsx` — render the online shell directly.
- Modify `src/app/globals.css` — remove local-table styles and add online shell/dialog responsive layout.
- Delete `src/components/game-table.tsx` — remove local AI, fake accounts, local reducer, and local ledger.
- Modify `README.md` — document online-only behavior and remove offline AI claims.
- Modify `progress.md` — record each completed change and verification result.

### Task 1: Lock the compact ranking copy with tests

**Files:**
- Create: `tests/hand-ranking.test.mjs`
- Create: `src/lib/game/hand-ranking.mjs`
- Create: `src/lib/game/hand-ranking.d.mts`

- [ ] **Step 1: Write the failing ranking test**

```js
// tests/hand-ranking.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPACT_HAND_RANKING,
  handRankingGroup,
} from "../src/lib/game/hand-ranking.mjs";

test("compact ranking keeps the approved Korean copy and order", () => {
  assert.deepEqual(COMPACT_HAND_RANKING, [
    { id: "gwang", label: "광땡", summary: "38광땡 〉 18광땡 〉 13광땡" },
    { id: "ddang", label: "땡", summary: "10땡 〉 … 〉 1땡" },
    { id: "special", label: "특수패", summary: "알리 〉 독사 〉 구삥 〉 장삥 〉 장사 〉 세륙" },
    { id: "kkeut", label: "끗", summary: "갑오 〉 8끗 〉 … 〉 1끗 〉 망통" },
  ]);
});

test("hand names map to the group highlighted by the rollup", () => {
  assert.equal(handRankingGroup("38광땡"), "gwang");
  assert.equal(handRankingGroup("8땡"), "ddang");
  assert.equal(handRankingGroup("알리"), "special");
  assert.equal(handRankingGroup("갑오"), "kkeut");
  assert.equal(handRankingGroup("망통"), "kkeut");
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --test tests/hand-ranking.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `hand-ranking.mjs`.

- [ ] **Step 3: Implement the immutable ranking helper**

```js
// src/lib/game/hand-ranking.mjs
export const COMPACT_HAND_RANKING = Object.freeze([
  Object.freeze({ id: "gwang", label: "광땡", summary: "38광땡 〉 18광땡 〉 13광땡" }),
  Object.freeze({ id: "ddang", label: "땡", summary: "10땡 〉 … 〉 1땡" }),
  Object.freeze({ id: "special", label: "특수패", summary: "알리 〉 독사 〉 구삥 〉 장삥 〉 장사 〉 세륙" }),
  Object.freeze({ id: "kkeut", label: "끗", summary: "갑오 〉 8끗 〉 … 〉 1끗 〉 망통" }),
]);

const SPECIAL_HANDS = new Set(["알리", "독사", "구삥", "장삥", "장사", "세륙"]);

export function handRankingGroup(name) {
  if (/광땡$/.test(name)) return "gwang";
  if (/^\d+땡$/.test(name)) return "ddang";
  if (SPECIAL_HANDS.has(name)) return "special";
  return "kkeut";
}
```

```ts
// src/lib/game/hand-ranking.d.mts
export type CompactHandRankingGroup = {
  readonly id: "gwang" | "ddang" | "special" | "kkeut";
  readonly label: string;
  readonly summary: string;
};

export const COMPACT_HAND_RANKING: readonly CompactHandRankingGroup[];
export function handRankingGroup(name: string): CompactHandRankingGroup["id"];
```

- [ ] **Step 4: Run the focused and full tests**

Run: `node --test tests/hand-ranking.test.mjs && npm test`

Expected: 2 focused tests PASS and the full suite PASS.

- [ ] **Step 5: Commit the helper with a Lore message**

Commit intent: `Keep beginner guidance concise during live play`

Required trailers: `Constraint: Approved copy abbreviates numeric 땡 and 끗 ranges`, `Tested: hand-ranking tests and full Node suite`, `Scope-risk: narrow`.

### Task 2: Build the shared accessible dialog frame

**Files:**
- Create: `src/components/app-dialog.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Create the dialog lifecycle component**

```tsx
// src/components/app-dialog.tsx
"use client";

import { type ReactNode, useEffect, useRef } from "react";

type AppDialogProps = {
  open: boolean;
  onClose: () => void;
  titleId: string;
  descriptionId?: string;
  className?: string;
  children: ReactNode;
};

export default function AppDialog({
  open,
  onClose,
  titleId,
  descriptionId,
  className = "",
  children,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      document.body.dataset.dialogOpen = "true";
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      delete document.body.dataset.dialogOpen;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    delete document.body.dataset.dialogOpen;
    if (dialog?.open) dialog.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`app-dialog ${className}`.trim()}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
```

- [ ] **Step 2: Add the dialog base styles**

```css
body[data-dialog-open="true"] { overflow: hidden; }
.app-dialog { width: min(520px, calc(100vw - 24px)); max-height: min(88dvh, 760px); margin: auto; padding: 0; overflow: auto; color: #f6ead2; background: #101f1c; border: 1px solid rgba(221, 180, 106, .48); border-radius: 22px; box-shadow: 0 30px 100px rgba(0, 0, 0, .7); }
.app-dialog::backdrop { background: rgba(3, 10, 9, .78); backdrop-filter: blur(8px); }
.app-dialog__surface { padding: 24px; }
.app-dialog__close { min-width: 44px; min-height: 44px; border: 0; border-radius: 50%; background: #21322e; color: #f6ead2; }
@media (max-width: 600px) { .app-dialog--ledger { width: 100%; max-width: none; max-height: 88dvh; margin: auto 0 0; border-radius: 22px 22px 0 0; } }
```

- [ ] **Step 3: Verify compilation**

Run: `npm run typecheck && npm run lint`

Expected: both commands exit 0.

- [ ] **Step 4: Commit the dialog frame with Lore trailers**

Commit intent: `Give account tasks a focused and reversible surface`

Required trailers: `Constraint: No new UI dependency`, `Tested: TypeScript and ESLint`, `Scope-risk: narrow`.

### Task 3: Move authentication into its own dialog

**Files:**
- Create: `src/components/account-auth-dialog.tsx`
- Modify: `src/components/account-room-panel.tsx`

- [ ] **Step 1: Create the authentication dialog contract**

```tsx
export type AuthPayload = {
  mode: "signin" | "signup";
  email: string;
  password: string;
  displayName: string;
};

type AccountAuthDialogProps = {
  open: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (payload: AuthPayload) => Promise<void>;
};
```

- [ ] **Step 2: Implement the form inside `AppDialog`**

```tsx
// src/components/account-auth-dialog.tsx
"use client";

import { type FormEvent, useState } from "react";
import AppDialog from "@/components/app-dialog";

export type AuthPayload = {
  mode: "signin" | "signup";
  email: string;
  password: string;
  displayName: string;
};

type Props = {
  open: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (payload: AuthPayload) => Promise<void>;
};

export default function AccountAuthDialog({ open, busy, error, onClose, onSubmit }: Props) {
  const [mode, setMode] = useState<AuthPayload["mode"]>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit({ mode, email, password, displayName });
    setPassword("");
  }

  return (
    <AppDialog open={open} onClose={onClose} titleId="auth-dialog-title" descriptionId="auth-dialog-description">
      <div className="app-dialog__surface auth-dialog">
        <header>
          <div><small>DDACKBAM ID</small><h2 id="auth-dialog-title">딱밤 계정으로 입장</h2></div>
          <button type="button" className="app-dialog__close" aria-label="로그인 창 닫기" onClick={onClose}>×</button>
        </header>
        <p id="auth-dialog-description">로그인하면 온라인 방과 계정별 딱밤 기록을 이용할 수 있어요.</p>
        <div className="accountRoom__tabs" role="tablist" aria-label="계정 메뉴">
          <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>로그인</button>
          <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>회원가입</button>
        </div>
        <form className="accountRoom__auth" onSubmit={submit}>
          {mode === "signup" ? <label>닉네임<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={24} required autoComplete="nickname" /></label> : null}
          <label>이메일<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
          <label>비밀번호<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required autoComplete={mode === "signup" ? "new-password" : "current-password"} /></label>
          <button className="accountRoom__primary" disabled={busy}>{busy ? "처리 중…" : mode === "signup" ? "딱밤 계정 만들기" : "온라인 대전 시작"}</button>
        </form>
        {error ? <p className="accountRoom__notice" role="alert">{error}</p> : null}
      </div>
    </AppDialog>
  );
}
```

- [ ] **Step 3: Refactor the parent auth handler**

Replace the `FormEvent` handler and parent-owned form fields with:

```tsx
async function handleAuth(payload: AuthPayload) {
  if (!supabase) return;
  setAuthBusy(true);
  setAuthError("");
  try {
    if (payload.mode === "signup") {
      const cleanName = payload.displayName.trim();
      if (cleanName.length < 2 || cleanName.length > 24) throw new Error("닉네임은 2~24자로 입력해 주세요.");
      const { data, error } = await supabase.auth.signUp({
        email: payload.email.trim(),
        password: payload.password,
        options: { data: { display_name: cleanName }, emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      if (!data.session) setAuthError("가입 확인 메일을 보냈어요.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: payload.email.trim(), password: payload.password });
      if (error) throw error;
    }
  } catch (error) {
    setAuthError(errorMessage(error));
  } finally {
    setAuthBusy(false);
  }
}
```

- [ ] **Step 4: Replace the unauthenticated early return**

Always render the online shell. When `user` is null, render `로그인이 필요해요`, the copy `방을 만들거나 참가하려면 딱밤 계정으로 로그인해 주세요.`, and one `로그인하고 시작` trigger plus `<AccountAuthDialog ... />`.

```tsx
{!user ? (
  <section className="online-shell__gate">
    <span className="eyebrow">SUPABASE REALTIME</span>
    <h1>로그인이 필요해요</h1>
    <p>방을 만들거나 참가하려면 딱밤 계정으로 로그인해 주세요.</p>
    <button type="button" className="accountRoom__primary" onClick={() => setAuthOpen(true)}>로그인하고 시작</button>
  </section>
) : (
  <OnlineLobbyOrRoom />
)}
<AccountAuthDialog open={authOpen} busy={authBusy} error={authError} onClose={() => setAuthOpen(false)} onSubmit={handleAuth} />
```

- [ ] **Step 5: Verify the auth shell**

Run: `npm run typecheck && npm run lint && npm run build`

Expected: all exit 0 and `/` remains statically generated.

- [ ] **Step 6: Commit the auth dialog**

Commit intent: `Keep sign-in out of the live table until it is needed`

Required trailers: `Constraint: Supabase auth flow and redirect origin remain unchanged`, `Tested: lint, typecheck, production build`, `Scope-risk: moderate`.

### Task 4: Move the directed hit ledger into its own dialog

**Files:**
- Create: `src/components/hit-ledger-dialog.tsx`
- Modify: `src/components/account-room-panel.tsx`

- [ ] **Step 1: Define the ledger dialog props**

```tsx
type Obligation = Tables<"hit_obligations">;
type Profile = Tables<"profiles">;

type HitLedgerDialogProps = {
  open: boolean;
  busy: boolean;
  error: string;
  userId: string;
  profile: Profile | null;
  names: Record<string, string>;
  obligations: Obligation[];
  onClose: () => void;
  onRecordHit: (obligation: Obligation) => Promise<void>;
};
```

- [ ] **Step 2: Render summary and direction correctly**

Compute remaining hits where `creditor_id === userId` as `내가 때릴 딱밤`, where `debtor_id === userId` as `내가 맞을 딱밤`, and use profile counters for cumulative delivered/received hits. Render each row as:

```tsx
const canRecord = item.creditor_id === userId && remaining !== null && remaining > 0n;
const actionCopy = `${names[item.creditor_id] ?? "플레이어"}이 ${names[item.debtor_id] ?? "플레이어"}을 때릴 딱밤`;

<li key={item.id}>
  <div><b>{actionCopy}</b><span>남음 {formatQuantity(item.remaining_hits)} · 완료 {item.delivered_hits.toLocaleString("ko-KR")}</span></div>
  {canRecord ? <button type="button" disabled={busy} onClick={() => void onRecordHit(item)}>한 대 때림</button> : null}
</li>
```

- [ ] **Step 3: Add the header trigger and remove the inline ledger**

Render `딱밤 장부 · {obligations.length}건` beside the account name and mount `HitLedgerDialog` once. Delete the old `accountRoom__ledger` section from `AccountRoomPanel`.

```tsx
<button type="button" className="accountRoom__ledgerTrigger" onClick={() => setLedgerOpen(true)}>
  딱밤 장부 · {obligations.length}건
</button>
<HitLedgerDialog
  open={ledgerOpen}
  busy={ledgerBusy}
  error={ledgerError}
  userId={user.id}
  profile={profile}
  names={names}
  obligations={obligations}
  onClose={() => setLedgerOpen(false)}
  onRecordHit={recordHit}
/>
```

- [ ] **Step 4: Separate ledger errors from room notices**

Use `ledgerError` for record failures and version conflicts. Keep room creation/join/ready feedback in `roomNotice`. Clear `ledgerError` on dialog open and after a successful record.

```tsx
const [roomNotice, setRoomNotice] = useState("");
const [authError, setAuthError] = useState("");
const [ledgerError, setLedgerError] = useState("");
const [authBusy, setAuthBusy] = useState(false);
const [ledgerBusy, setLedgerBusy] = useState(false);
```

- [ ] **Step 5: Verify the ledger integration**

Run: `npm run typecheck && npm run lint && npm test`

Expected: all exit 0.

- [ ] **Step 6: Commit the ledger dialog**

Commit intent: `Keep opposite hit rights visible without crowding the table`

Required trailers: `Constraint: Creditor records a physical hit against the debtor`, `Directive: Do not net opposite obligations`, `Tested: lint, typecheck, full Node suite`, `Scope-risk: moderate`.

### Task 5: Add the current-hand name and ranking rollup

**Files:**
- Modify: `src/components/online-room-game.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Evaluate only the current account for pre-showdown guidance**

```tsx
import { COMPACT_HAND_RANKING, handRankingGroup } from "@/lib/game/hand-ranking.mjs";

const myHand = round.hands[userId];
const myEvaluation = myHand ? evaluateHand(myHand) : null;
const currentRankingGroup = myEvaluation ? handRankingGroup(myEvaluation.name) : null;
```

- [ ] **Step 2: Render an accessible rollup only in the current account seat**

```tsx
{playerId === userId && myEvaluation ? (
  <details className="onlineGame__rankRollup">
    <summary><strong>내 패 · {myEvaluation.name}</strong><span>족보 보기</span></summary>
    <div className="onlineGame__rankList">
      {COMPACT_HAND_RANKING.map((group) => (
        <div key={group.id} className={currentRankingGroup === group.id ? "is-current" : ""}>
          <b>{group.label}</b><span>{group.summary}</span>
        </div>
      ))}
    </div>
  </details>
) : null}
```

Keep the existing showdown hand name for every player. Do not render the rollup for other accounts.

- [ ] **Step 3: Style the rollup without obscuring actions**

Use a compact bordered summary, a maximum-height ranking list, current-group gold highlight, and a single-column mobile layout. Do not add combination explanations or numeric rank labels.

```css
.onlineGame__rankRollup { grid-column: 1 / -1; margin-top: 8px; border: 1px solid #4b655d; border-radius: 10px; background: #0c1d1a; }
.onlineGame__rankRollup summary { display: flex; justify-content: space-between; gap: 12px; min-height: 44px; padding: 10px 12px; cursor: pointer; list-style: none; }
.onlineGame__rankRollup summary strong { color: #f0b75f; }
.onlineGame__rankList { display: grid; gap: 6px; max-height: 250px; overflow: auto; padding: 0 10px 10px; }
.onlineGame__rankList div { padding: 7px 8px; border-top: 1px solid #294038; }
.onlineGame__rankList div.is-current { border: 1px solid #956b35; border-radius: 7px; background: #3a291b; }
.onlineGame__rankList b, .onlineGame__rankList span { display: block; }
```

- [ ] **Step 4: Expose concise game state for the mandated web-game test client**

Add a browser-safe effect that assigns `window.render_game_to_text` to return JSON containing `mode`, `roundNumber`, `phase`, `userId`, `myHandName`, `turnPlayerId`, `currentStake`, and visible player IDs. Clean it up on unmount. Add a no-op deterministic `window.advanceTime = () => undefined` because this turn-based game has no frame simulation.

```tsx
useEffect(() => {
  const gameWindow = window as Window & {
    render_game_to_text?: () => string;
    advanceTime?: (milliseconds: number) => void;
  };
  gameWindow.render_game_to_text = () => JSON.stringify({
    mode: "online",
    roundNumber: round?.roundNumber ?? null,
    phase: round?.phase ?? "waiting",
    userId,
    myHandName: myEvaluation?.name ?? null,
    turnPlayerId: round?.betting.turnPlayerId ?? null,
    currentStake: round ? String(round.betting.currentStake) : null,
    playerIds: round?.playerIds ?? [],
  });
  gameWindow.advanceTime = () => undefined;
  return () => {
    delete gameWindow.render_game_to_text;
    delete gameWindow.advanceTime;
  };
}, [myEvaluation?.name, round, userId]);
```

- [ ] **Step 5: Verify the helper and component**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: all commands exit 0.

- [ ] **Step 6: Commit the rollup**

Commit intent: `Let new players identify their hand without revealing opponents`

Required trailers: `Constraint: No combination explanation or ordinal rank copy`, `Directive: Never expose opponent guidance before showdown`, `Tested: tests, lint, typecheck, production build`, `Scope-risk: narrow`.

### Task 6: Remove the local product surface and dead styles

**Files:**
- Modify: `src/app/page.tsx`
- Delete: `src/components/game-table.tsx`
- Modify: `src/app/globals.css`
- Modify: `README.md`
- Modify: `progress.md`

- [ ] **Step 1: Point the route directly at the online shell**

```tsx
import AccountRoomPanel from "@/components/account-room-panel";

export default function Home() {
  return <AccountRoomPanel />;
}
```

- [ ] **Step 2: Delete the local component**

Delete `src/components/game-table.tsx` after confirming `rg -n "GameTable|game-table" src` finds only `page.tsx` before the route edit and no matches afterward.

- [ ] **Step 3: Remove dead local CSS**

Delete selectors for `.content-grid`, `.game-panel`, `.table-stage`, `.player-seat`, `.preview-seat`, `.action-dock`, the local `.ledger-panel`, and their responsive overrides. Preserve the brand/header/footer tokens and add the online shell layout used by `AccountRoomPanel`.

```css
.online-shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 40px; }
.online-shell__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.online-shell__actions { display: flex; align-items: center; gap: 8px; }
.online-shell__main { margin-top: 22px; }
.online-shell__gate { min-height: 60vh; display: grid; place-items: center; align-content: center; text-align: center; }
@media (max-width: 680px) { .online-shell { width: min(100% - 20px, 1180px); } .online-shell__header { align-items: flex-start; } .online-shell__actions { flex-wrap: wrap; justify-content: flex-end; } }
```

- [ ] **Step 4: Correct product documentation**

Replace the opening README paragraph with:

```md
현금 대신 딱밤으로 즐기는 2~4인용 온라인 2장 섯다 웹 게임입니다. Supabase 계정으로 로그인해 코드 방을 만들거나 참가하고, 계정별 딱밤 장부를 이어서 관리할 수 있습니다.
```

Delete `환경 변수가 없어도 로컬 AI 체험 게임은 동작합니다.` and state that Supabase environment variables are required for play.

- [ ] **Step 5: Record progress and run the full static checks**

Append completed files and verification results to `progress.md`.

Run the search first: `rg -n "로컬 게임|AI 계정|GameTable|game-table" src README.md`

Expected: no matches and `rg` exit 1.

Then run: `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.

Expected: every command exits 0.

- [ ] **Step 6: Commit the online-only surface**

Commit intent: `Make real-account multiplayer the only playable experience`

Required trailers: `Constraint: Supabase configuration is required`, `Rejected: Keep a hidden local demo | duplicates state and confuses account ownership`, `Tested: search, tests, lint, typecheck, production build`, `Scope-risk: broad`.

### Task 7: Browser, visual, Git, and production verification

**Files:**
- Modify only if verification finds a defect.

- [ ] **Step 1: Start the app and run the required web-game client**

Run `npm run dev` in the background. Then run the installed `develop-web-game` client against the local URL with a click on `로그인하고 시작`, a short pause, and a screenshot output directory. Inspect the generated screenshot and captured `render_game_to_text` JSON.

- [ ] **Step 2: Verify modal behavior in a real browser**

Check desktop and mobile widths for:

- Login trigger → modal opens → login/signup tabs switch → `Esc` closes → focus returns.
- Ledger trigger → modal opens → summary and both obligation directions remain separate → mobile bottom sheet stays within `88dvh`.
- Game seat → `내 패 · {name}` visible → `족보 보기` expands the four approved groups → only the current group is highlighted.
- Opponent cards and rollup remain hidden until showdown.

- [ ] **Step 3: Run visual-verdict before any visual correction**

Persist the verdict JSON in `.omx/state/online-only-modal-ui/ralph-progress.json`. If the verdict identifies a defect, make one focused correction and repeat the web-game client plus verdict loop.

- [ ] **Step 4: Scan console and runtime errors**

Confirm zero browser console errors locally. After deployment, use Vercel runtime errors for the new project and confirm zero new clusters.

- [ ] **Step 5: Run the final verification suite**

Run: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `git diff --check`, and `git status --short --branch`.

Expected: all checks pass and only intentional tracked changes are present before the release commit.

- [ ] **Step 6: Commit any verification-only fix with Lore trailers**

Use a commit only if verification changed tracked files. Include exact browser widths and commands in `Tested:` and any untested multi-account scenario in `Not-tested:`.

- [ ] **Step 7: Push and verify Vercel production**

Push `main` to `origin`, wait for the Git-linked `ddakbamonline-live` production deployment to reach `READY`, and fetch `https://ddakbamonline-live.vercel.app/`. Expected: HTTP 200, online-only Korean title/copy, no local-game text, and no Vercel runtime errors.

## Final self-review checklist

- Every approved spec requirement maps to Tasks 3–6.
- The hand copy exactly matches the approved compact rollup and contains no ordinal label such as `특수패 1위`.
- The ledger record action is available to the creditor, who physically hits the debtor; opposite rights remain separate.
- Component contracts use the same `Obligation`, `Profile`, `userId`, and callback semantics across tasks.
- No new dependency or database migration is introduced.

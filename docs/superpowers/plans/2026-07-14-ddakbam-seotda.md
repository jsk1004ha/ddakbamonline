# 딱밤 섯다 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회원가입, 코드 방, 체험 모드가 있는 2~4인용 2장 딱밤 섯다를 구현하고 Supabase 및 Vercel에 연결한다.

**Architecture:** 순수 JavaScript 게임 엔진이 족보, 2~4인 턴, 베팅 상태, 계정 ID 기반 비상계 딱밤 채무를 담당한다. React 클라이언트 컴포넌트는 로컬 AI 체험 또는 Supabase Realtime 방 상태를 렌더링한다. 데이터베이스 권한은 방 멤버십 및 계정 간 의무 당사자 기반 RLS로 제한한다.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, Node test runner, Supabase Auth/Postgres, Vercel.

---

## 파일 구조

- `src/lib/game/engine.mjs`: 카드 생성, 족보 평가, 베팅 전이, 딱밤 장부를 다루는 순수 함수.
- `tests/game-engine.test.mjs`: 엔진 계약의 회귀 테스트.
- `src/components/game-table.tsx`: 2~4개 계정 좌석, 플레이 가능한 전체 테이블과 AI 턴.
- `src/components/room-lobby.tsx`: 방 만들기, 코드 참가, 참가자 목록과 Realtime 구독.
- `src/components/auth-panel.tsx`: 이메일 가입/로그인/로그아웃 UI.
- `src/lib/supabase/client.ts`: 환경변수가 있을 때만 만드는 지연 초기화 브라우저 클라이언트.
- `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`: 앱 셸, 메타데이터, 반응형 시각 시스템.
- `supabase/migrations/20260714100000_initial_schema.sql`: profiles/game_rooms/room_members/game_results/hit_obligations/RLS/트리거.
- `public/cards/*`: 출처가 표시된 화투 패 자산.

### Task 1: 테스트 우선 게임 엔진

**Files:**
- Create: `tests/game-engine.test.mjs`
- Create: `src/lib/game/engine.mjs`

- [ ] **Step 1: 족보와 채무 장부의 실패 테스트 작성**

```js
import { evaluateHand, settleRound } from "../src/lib/game/engine.mjs";
assert.equal(evaluateHand([{ month: 3, bright: true }, { month: 8, bright: true }]).name, "38광땡");
assert.deepEqual(settleRound([{ debtorId: "a", creditorId: "b", remaining: 3 }], { winnerId: "a", loserIds: ["b"], stake: 5 })[1], { debtorId: "b", creditorId: "a", remaining: 5, delivered: 0 });
```

- [ ] **Step 2: `npm test`를 실행해 모듈 부재로 실패하는지 확인**
- [ ] **Step 3: 모든 표준 족보와 2~4인 `dealRound`, `applyAction`, `settleRound`, `recordHit`을 최소 구현**
- [ ] **Step 4: `npm test`에서 모든 테스트가 통과하는지 확인**

### Task 2: 카드 자산과 시각 시스템

**Files:**
- Create: `public/cards/1.png` through `public/cards/20.png`, `public/cards/back.png`
- Modify: `src/app/globals.css`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: 원본 저장소의 20장과 뒷면을 복사하고 SHA-256 목록을 기록**
- [ ] **Step 2: 먹색/청록/감귤/한지색 토큰, 목재 배경, 패/패널/버튼/모바일 스타일을 작성**
- [ ] **Step 3: 한글 메타데이터와 Geist 변수를 `<html>`에 적용**
- [ ] **Step 4: `npm run lint`로 CSS 연동 컴포넌트의 정적 오류가 없는지 확인**

### Task 3: 플레이 가능한 2~4인 게임 테이블

**Files:**
- Create: `src/components/game-table.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: 2~4인 엔진 초기 상태, 턴 순환, 카드 중복 방지 계약을 테스트에 추가하고 실패 확인**
- [ ] **Step 2: AI가 약한 패면 받기, 중간 이상이면 제한 없이 임의 수만큼 올리는 턴 로직 작성**
- [ ] **Step 3: 테이블 둘레 2~4개 계정 패, 판 딱밤, 로그, 받기/올리기, 결과 모달, 새 판을 렌더링**
- [ ] **Step 4: 계정별 방향성 딱밤 장부 각각에 `1대 때림` 버튼을 연결하고 누적 횟수를 유지**
- [ ] **Step 5: `npm test && npm run typecheck` 실행**

### Task 4: Supabase 인증과 결과 저장

**Files:**
- Create: `src/lib/supabase/client.ts`
- Create: `src/components/auth-panel.tsx`
- Create: `src/components/room-lobby.tsx`
- Create: `supabase/migrations/20260714100000_initial_schema.sql`
- Modify: `src/components/game-table.tsx`

- [ ] **Step 1: `@supabase/supabase-js`를 고정 버전으로 설치하고 lockfile 커밋**
- [ ] **Step 2: 모듈 로드시 환경변수를 요구하지 않는 `getSupabaseBrowserClient()` 구현**
- [ ] **Step 3: 이메일 가입/로그인/로그아웃, 2~4인 AI 체험 모드, 방 만들기/코드 참가를 구현**
- [ ] **Step 4: profiles/game_rooms/room_members/game_results/hit_obligations 테이블, 멤버십·당사자 RLS, 신규 사용자 프로필 트리거 SQL 작성**
- [ ] **Step 5: 방 변경 Realtime 구독과 계정별 딱밤 의무 저장/완료 갱신을 연결**
- [ ] **Step 6: MCP `execute_sql`로 스키마 적용 후 멤버십/당사자 정책과 advisors 결과 확인**

### Task 5: 통합 검증과 접근성

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: 카드 출처, 로컬 실행, Supabase 환경변수, 게임 규칙을 README에 기록**
- [ ] **Step 2: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`를 순서대로 실행**
- [ ] **Step 3: 브라우저에서 1440×900과 390×844 화면을 확인하고 버튼 키보드 조작, 라벨, 대비를 수정**
- [ ] **Step 4: 디버그 로그, 임시 파일, 하드코딩 비밀값이 없는지 `git diff --check`와 검색으로 확인**

### Task 6: 게시

**Files:**
- Verify: `.vercel/project.json`
- Verify: `.env.local`

- [ ] **Step 1: 필수 환경변수 이름이 로컬과 Vercel에 모두 있는지 값 노출 없이 확인**
- [ ] **Step 2: Lore 형식 커밋을 만들고 `main`에 병합해 `origin`으로 푸시**
- [ ] **Step 3: Vercel 프로덕션 배포 후 READY 상태와 페이지 응답을 확인**
- [ ] **Step 4: 최근 프로덕션 런타임 오류와 빌드 로그를 확인해 오류가 있으면 수정 후 재배포**

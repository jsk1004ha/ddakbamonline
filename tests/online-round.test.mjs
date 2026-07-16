import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readPublicOnlineRound } from "../src/lib/game/online-round.mjs";

const readSource = async (url) =>
  (await readFile(url, "utf8")).replace(/\r\n?/g, "\n");

const onlineGameSource = await readSource(
  new URL("../src/components/online-room-game.tsx", import.meta.url),
);
const accountRoomSource = await readSource(
  new URL("../src/components/account-room-panel.tsx", import.meta.url),
);
const databaseTypesSource = await readSource(
  new URL("../src/lib/supabase/database.types.ts", import.meta.url),
);
const globalStylesSource = await readSource(
  new URL("../src/app/globals.css", import.meta.url),
);

const safeRound = {
  schema: 2,
  roundToken: "00000000-0000-4000-8000-000000000001",
  roundNumber: 1,
  playerIds: ["a", "b"],
  foldedPlayerIds: [],
  foldedStakes: {},
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

const showdownRound = {
  ...safeRound,
  betting: {
    ...safeRound.betting,
    commitments: { a: 3, b: 3 },
    currentStake: 3,
    pot: 6,
    turnPlayerId: null,
    lastAggressorId: "a",
    status: "complete",
    pendingPlayerIds: [],
  },
  phase: "showdown",
  evaluations: {
    a: { name: "알리", rank: 1, tiebreak: 6, months: [1, 2] },
    b: { name: "8끗", rank: 0, tiebreak: 8, months: [2, 6] },
  },
  winnerIds: ["a"],
};

const foldedBettingRound = {
  ...safeRound,
  playerIds: ["a", "b", "c"],
  foldedPlayerIds: ["b"],
  foldedStakes: { b: 1 },
  betting: {
    ...safeRound.betting,
    playerIds: ["a", "b", "c"],
    commitments: { a: 0, b: 1, c: 0 },
    currentStake: 3,
    pot: 1,
    pendingPlayerIds: ["a", "c"],
  },
};

const foldedShowdownRound = {
  ...foldedBettingRound,
  betting: {
    ...foldedBettingRound.betting,
    commitments: { a: 3, b: 1, c: 3 },
    pot: 7,
    turnPlayerId: null,
    lastAggressorId: "a",
    status: "complete",
    pendingPlayerIds: [],
  },
  phase: "showdown",
  evaluations: {
    a: { name: "알리", rank: 1, tiebreak: 6, months: [1, 2] },
    b: { name: "38광땡", rank: 3, tiebreak: 38, months: [3, 8] },
    c: { name: "8끗", rank: 0, tiebreak: 8, months: [2, 6] },
  },
  winnerIds: ["a"],
};

function withoutKey(value, keyToRemove) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== keyToRemove),
  );
}

test("accepts schema 2 public betting state without card data", () => {
  assert.deepEqual(readPublicOnlineRound(safeRound), safeRound);
  assert.equal(JSON.stringify(safeRound).includes("imageId"), false);
});

test("accepts schema 2 showdown evaluations and winner IDs", () => {
  assert.deepEqual(readPublicOnlineRound(showdownRound), showdownRound);
});

test("accepts a folded showdown while ignoring a folded 38광땡", () => {
  assert.deepEqual(
    readPublicOnlineRound(foldedShowdownRound),
    foldedShowdownRound,
  );
});

test("accepts betting with a folded commitment below a later stake", () => {
  assert.deepEqual(readPublicOnlineRound(foldedBettingRound), foldedBettingRound);
});

test("rejects betting after folds leave one active player", () => {
  const oneSurvivorBettingRound = {
    ...foldedBettingRound,
    foldedPlayerIds: ["b", "c"],
    foldedStakes: { b: 1, c: 1 },
    betting: {
      ...foldedBettingRound.betting,
      commitments: { a: 0, b: 1, c: 1 },
      pot: 2,
      pendingPlayerIds: ["a"],
    },
  };

  assert.equal(readPublicOnlineRound(oneSurvivorBettingRound), null);
});

test("requires exact top-level folded fields", () => {
  assert.equal(
    readPublicOnlineRound(withoutKey(safeRound, "foldedPlayerIds")),
    null,
  );
  assert.equal(readPublicOnlineRound(withoutKey(safeRound, "foldedStakes")), null);
  assert.equal(
    readPublicOnlineRound({ ...safeRound, foldedAt: { a: 1 } }),
    null,
  );
});

test("rejects outsider, duplicate, unordered, and exhaustive folded IDs", () => {
  const malformedStates = [
    {
      ...foldedBettingRound,
      foldedPlayerIds: ["outsider"],
      foldedStakes: { outsider: 1 },
    },
    {
      ...foldedBettingRound,
      foldedPlayerIds: ["b", "b"],
      foldedStakes: { b: 1 },
    },
    {
      ...foldedBettingRound,
      foldedPlayerIds: ["c", "a"],
      foldedStakes: { c: 1, a: 1 },
    },
    {
      ...foldedBettingRound,
      foldedPlayerIds: ["a", "b", "c"],
      foldedStakes: { a: 0, b: 1, c: 0 },
    },
  ];

  for (const state of malformedStates) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});

test("rejects folded player arrays with non-JSON container behavior", () => {
  const withExtraProperty = ["b"];
  withExtraProperty.hands = ["hidden"];

  const withCustomPrototype = ["b"];
  Object.setPrototypeOf(
    withCustomPrototype,
    Object.create(Array.prototype),
  );

  const withSymbol = ["b"];
  withSymbol[Symbol("hands")] = ["hidden"];

  const withAccessor = ["b"];
  Object.defineProperty(withAccessor, "0", {
    configurable: true,
    enumerable: true,
    get: () => "b",
  });

  for (const foldedPlayerIds of [
    withExtraProperty,
    withCustomPrototype,
    withSymbol,
    withAccessor,
  ]) {
    assert.equal(
      readPublicOnlineRound({ ...foldedBettingRound, foldedPlayerIds }),
      null,
    );
  }
});

test("requires folded stakes to exactly match positive canonical commitments", () => {
  const customPrototypeStake = Object.assign(Object.create({ hidden: 1 }), {
    b: 1,
  });
  const malformedFoldedStakes = [
    {},
    { b: 1, outsider: 1 },
    { outsider: 1 },
    { b: 2 },
    { b: 4 },
    { b: 0 },
    { b: -1 },
    { b: 1.5 },
    { b: Number.MAX_SAFE_INTEGER + 1 },
    { b: "01" },
    { b: "+1" },
    { b: " 1" },
    customPrototypeStake,
  ];

  for (const foldedStakes of malformedFoldedStakes) {
    assert.equal(
      readPublicOnlineRound({ ...foldedBettingRound, foldedStakes }),
      null,
    );
  }
});

test("rejects folded players as pending, turn, aggressor, or winner", () => {
  const malformedStates = [
    {
      ...foldedBettingRound,
      betting: {
        ...foldedBettingRound.betting,
        turnPlayerId: "b",
        pendingPlayerIds: ["b", "a", "c"],
      },
    },
    {
      ...foldedBettingRound,
      betting: { ...foldedBettingRound.betting, turnPlayerId: "b" },
    },
    {
      ...foldedBettingRound,
      betting: { ...foldedBettingRound.betting, lastAggressorId: "b" },
    },
    { ...foldedShowdownRound, winnerIds: ["b"] },
  ];

  for (const state of malformedStates) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});

test("requires the exact strongest active winner set, including ties", () => {
  const activeTieRound = {
    ...foldedShowdownRound,
    evaluations: {
      ...foldedShowdownRound.evaluations,
      c: { name: "알리", rank: 1, tiebreak: 6, months: [2, 4] },
    },
    winnerIds: ["a", "c"],
  };

  assert.deepEqual(readPublicOnlineRound(activeTieRound), activeTieRound);
  assert.equal(
    readPublicOnlineRound({ ...activeTieRound, winnerIds: ["a"] }),
    null,
  );
});

test("accepts complete betting when folds leave one active player", () => {
  const oneActivePlayerRound = {
    ...foldedShowdownRound,
    foldedPlayerIds: ["a", "c"],
    foldedStakes: { a: 3, c: 1 },
    betting: {
      ...foldedShowdownRound.betting,
      commitments: { a: 3, b: 1, c: 1 },
      pot: 5,
      lastAggressorId: null,
    },
    winnerIds: ["b"],
  };

  assert.deepEqual(
    readPublicOnlineRound(oneActivePlayerRound),
    oneActivePlayerRound,
  );
});

test("preserves a huge exact frozen folded stake", () => {
  const hugeStake = "900719925474099312345678901234567890";
  const frozenFoldedStakes = Object.freeze({ a: hugeStake });
  const hugeRound = {
    ...showdownRound,
    foldedPlayerIds: ["a"],
    foldedStakes: frozenFoldedStakes,
    betting: {
      ...showdownRound.betting,
      commitments: { a: hugeStake, b: hugeStake },
      currentStake: hugeStake,
      pot: (BigInt(hugeStake) * 2n).toString(),
      lastAggressorId: "b",
    },
    winnerIds: ["b"],
  };

  assert.deepEqual(readPublicOnlineRound(hugeRound), hugeRound);
  assert.equal(hugeRound.foldedStakes.a, hugeStake);
  assert.equal(Object.isFrozen(hugeRound.foldedStakes), true);
});

test("rejects strings for safely representable exact quantities", () => {
  const foldedSafeStringRound = {
    ...showdownRound,
    foldedPlayerIds: ["a"],
    foldedStakes: { a: "1" },
    betting: {
      ...showdownRound.betting,
      commitments: { a: 1, b: 3 },
      pot: 4,
      lastAggressorId: "b",
    },
    winnerIds: ["b"],
  };
  const malformedStates = [
    {
      ...safeRound,
      betting: { ...safeRound.betting, currentStake: "1" },
    },
    {
      ...showdownRound,
      betting: {
        ...showdownRound.betting,
        commitments: { a: "3", b: 3 },
      },
    },
    {
      ...showdownRound,
      betting: { ...showdownRound.betting, pot: "6" },
    },
    foldedSafeStringRound,
  ];

  for (const state of malformedStates) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});

test("rejects negative zero in every exact quantity position", () => {
  const malformedStates = [
    {
      ...safeRound,
      betting: { ...safeRound.betting, currentStake: -0 },
    },
    {
      ...safeRound,
      betting: { ...safeRound.betting, pot: -0 },
    },
    {
      ...safeRound,
      betting: {
        ...safeRound.betting,
        commitments: { a: -0, b: 0 },
      },
    },
    {
      ...foldedBettingRound,
      foldedStakes: { b: -0 },
      betting: {
        ...foldedBettingRound.betting,
        commitments: { a: 0, b: -0, c: 0 },
        pot: 0,
      },
    },
  ];

  for (const state of malformedStates) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});

test("rejects legacy state and every state with a hands property", () => {
  assert.equal(readPublicOnlineRound({ ...safeRound, schema: 1 }), null);
  assert.equal(readPublicOnlineRound({ ...safeRound, hands: { a: [] } }), null);
  assert.equal(readPublicOnlineRound({ ...safeRound, hands: undefined }), null);
});

test("rejects malformed player, betting, and quantity structures", () => {
  const malformedStates = [
    null,
    [],
    { ...safeRound, playerIds: ["a"] },
    { ...safeRound, playerIds: ["a", "a"] },
    { ...safeRound, playerIds: ["a", "b", "c", "d", "e"] },
    { ...safeRound, betting: { ...safeRound.betting, playerIds: ["b", "a"] } },
    {
      ...safeRound,
      betting: { ...safeRound.betting, commitments: { a: 0, outsider: 0 } },
    },
    { ...safeRound, betting: { ...safeRound.betting, currentStake: 0 } },
    { ...safeRound, betting: { ...safeRound.betting, currentStake: 1.5 } },
    { ...safeRound, betting: { ...safeRound.betting, pot: 1 } },
    { ...safeRound, betting: { ...safeRound.betting, turnPlayerId: "b" } },
    {
      ...safeRound,
      betting: { ...safeRound.betting, pendingPlayerIds: ["a", "a"] },
    },
    {
      ...safeRound,
      betting: { ...safeRound.betting, lastAggressorId: "outsider" },
    },
    {
      ...safeRound,
      betting: { ...safeRound.betting, lastAggressorId: "a" },
    },
    {
      ...foldedBettingRound,
      betting: {
        ...foldedBettingRound.betting,
        pendingPlayerIds: ["a"],
      },
    },
    {
      ...foldedBettingRound,
      betting: {
        ...foldedBettingRound.betting,
        commitments: { a: 3, b: 1, c: 0 },
        pot: 4,
      },
    },
  ];

  for (const state of malformedStates) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});

test("requires phase-coherent evaluations, winners, and completed betting", () => {
  const malformedStates = [
    { ...safeRound, evaluations: showdownRound.evaluations },
    { ...safeRound, winnerIds: ["a"] },
    { ...showdownRound, evaluations: {} },
    { ...showdownRound, winnerIds: [] },
    { ...showdownRound, winnerIds: ["outsider"] },
    {
      ...showdownRound,
      evaluations: {
        ...showdownRound.evaluations,
        a: { ...showdownRound.evaluations.a, imageId: 1 },
      },
    },
    {
      ...showdownRound,
      evaluations: {
        ...showdownRound.evaluations,
        a: { ...showdownRound.evaluations.a, months: [0, 11] },
      },
    },
    { ...showdownRound, betting: { ...showdownRound.betting, status: "betting" } },
    {
      ...foldedShowdownRound,
      betting: {
        ...foldedShowdownRound.betting,
        commitments: { a: 2, b: 1, c: 3 },
        pot: 6,
      },
    },
    {
      ...foldedShowdownRound,
      evaluations: {
        a: foldedShowdownRound.evaluations.a,
        c: foldedShowdownRound.evaluations.c,
      },
    },
    {
      ...foldedShowdownRound,
      foldedPlayerIds: ["a", "c"],
      foldedStakes: { a: 3, c: 1 },
      betting: {
        ...foldedShowdownRound.betting,
        commitments: { a: 3, b: 1, c: 1 },
        pot: 5,
        lastAggressorId: "b",
      },
      winnerIds: ["b"],
    },
  ];

  for (const state of malformedStates) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});

test("rejects unexpected public keys that could smuggle hidden card data", () => {
  assert.equal(readPublicOnlineRound({ ...safeRound, imageId: 1 }), null);
  assert.equal(readPublicOnlineRound({ ...safeRound, cardId: 1 }), null);
  assert.equal(readPublicOnlineRound({ ...safeRound, cards: [1, 2] }), null);
  assert.equal(
    readPublicOnlineRound({
      ...safeRound,
      betting: { ...safeRound.betting, cards: [1, 2] },
    }),
    null,
  );
  assert.equal(
    readPublicOnlineRound({
      ...foldedBettingRound,
      foldedStakes: { b: 1, imageId: 1 },
    }),
    null,
  );
});

test("keeps hidden hands and game settlement outside the React client", () => {
  for (const forbiddenAuthority of [
    "dealRound",
    "applyAction",
    "compareHands",
    'from("game_results")',
    'from("hit_obligations").upsert',
  ]) {
    assert.equal(onlineGameSource.includes(forbiddenAuthority), false);
  }
  assert.doesNotMatch(
    onlineGameSource,
    /\.from\("game_rooms"\)[\s\S]{0,160}\.update\(/,
  );
});

test("uses only authenticated game RPCs and RLS-visible hand reads", () => {
  assert.match(onlineGameSource, /\.rpc\("play_game_action"/);
  assert.match(onlineGameSource, /\.from\("game_round_hands"\)/);
  assert.match(accountRoomSource, /\.rpc\("start_game_round"/);
  assert.match(accountRoomSource, /\.rpc\("record_physical_hit"/);
  assert.doesNotMatch(
    accountRoomSource,
    /\.from\("hit_obligations"\)[\s\S]{0,160}\.update\(/,
  );
  assert.doesNotMatch(
    accountRoomSource,
    /\.from\("game_rooms"\)[\s\S]{0,160}\.update\(/,
  );
});

test("keeps diagnostics nonidentifying and renders two backs for a hidden hand", () => {
  const diagnosticsSource = onlineGameSource.match(
    /gameWindow\.render_game_to_text[\s\S]*?gameWindow\.advanceTime/,
  )?.[0];
  assert.ok(diagnosticsSource);
  assert.doesNotMatch(diagnosticsSource, /\b(?:userId|playerIds|turnPlayerId)\s*:/);
  assert.match(diagnosticsSource, /playerCount:/);
  assert.match(onlineGameSource, /visibleCards \?\? \[null, null\]/);
});

test("declares exact room presence and lifecycle RPC database types", () => {
  const roomMembers = databaseTypesSource.match(
    /room_members:\s*\{[\s\S]*?Relationships:/,
  )?.[0];
  assert.ok(roomMembers);
  assert.match(roomMembers, /Row:\s*\{[\s\S]*?last_seen_at:\s*string;/);
  assert.match(roomMembers, /Insert:\s*\{[\s\S]*?last_seen_at\?:\s*string;/);
  assert.match(roomMembers, /Update:\s*\{[\s\S]*?last_seen_at\?:\s*string;/);

  for (const rpc of ["close_game_room", "leave_game_room"]) {
    assert.match(
      databaseTypesSource,
      new RegExp(
        `${rpc}:\\s*\\{[\\s\\S]*?Args:\\s*\\{\\s*expected_version:\\s*number;\\s*target_room:\\s*string;?\\s*\\};[\\s\\S]*?Returns:\\s*Json;`,
      ),
    );
  }
  for (const rpc of ["expire_idle_game_room", "touch_room_presence"]) {
    assert.match(
      databaseTypesSource,
      new RegExp(
        `${rpc}:\\s*\\{[\\s\\S]*?Args:\\s*\\{\\s*target_room:\\s*string;?\\s*\\};[\\s\\S]*?Returns:\\s*Json;`,
      ),
    );
  }

  assert.match(databaseTypesSource, /raise_to:\s*string \| number \| null;/);
  assert.match(databaseTypesSource, /stake:\s*string \| number;/);
  assert.match(databaseTypesSource, /remaining_hits:\s*string \| number;/);
});

test("recovers closed, missing, and membership-deleted rooms to the game main", () => {
  assert.match(
    accountRoomSource,
    /const returnToGameMain = useCallback\(\(message\?: string\)/,
  );
  assert.match(
    accountRoomSource,
    /setCurrentRoom\(null\);[\s\S]*?setMembers\(\[\]\);/,
  );
  assert.match(accountRoomSource, /PGRST116/);
  assert.match(accountRoomSource, /!nextRoom/);
  assert.match(accountRoomSource, /nextRoom\.status === "closed"/);
  assert.match(
    accountRoomSource,
    /\.from\("room_members"\)[\s\S]*?\.eq\("room_id", roomId\)[\s\S]*?\.eq\("user_id", user\.id\)/,
  );
  assert.match(accountRoomSource, /payload\.eventType === "DELETE"/);
  assert.match(accountRoomSource, /payload\.old\.user_id === user\.id/);
});

test("routes leave flows through lifecycle RPCs and isolates the playing branch", () => {
  const leaveRoomSource = accountRoomSource.match(
    /async function leaveRoom\(\)[\s\S]*?\r?\n  }\r?\n\r?\n  async function startRoom/,
  )?.[0];
  assert.ok(leaveRoomSource);
  assert.match(leaveRoomSource, /\.rpc\("leave_game_room"/);
  assert.doesNotMatch(leaveRoomSource, /\.delete\(\)/);
  assert.match(accountRoomSource, /if \(room\?\.status === "playing"\)/);
  assert.match(
    accountRoomSource,
    /<section\s+className="accountRoom accountRoom--playing"[^>]*>[\s\S]*?<OnlineRoomGame/,
  );
  assert.match(accountRoomSource, /members=\{members\}/);
  assert.match(accountRoomSource, /onReturnToMain=\{returnToGameMain\}/);
  assert.match(accountRoomSource, /onOpenLedger=/);
  assert.equal(
    (accountRoomSource.match(/<HitLedgerDialog/g) ?? []).length,
    1,
  );
});

test("dedicated game exposes fold, end, presence, and expiry controls", () => {
  for (const rpc of [
    "touch_room_presence",
    "expire_idle_game_room",
    "close_game_room",
    "leave_game_room",
  ]) {
    assert.match(onlineGameSource, new RegExp(`\\.rpc\\("${rpc}"`));
  }
  assert.match(onlineGameSource, />죽기</);
  assert.match(onlineGameSource, />게임 끝내기</);
  assert.match(onlineGameSource, /20_000/);
  assert.match(onlineGameSource, /10_000/);
  assert.match(onlineGameSource, /60_000/);
  assert.match(onlineGameSource, /visibilitychange/);
  assert.match(onlineGameSource, /onlineGame__myCards/);
  assert.match(onlineGameSource, /onlineGame__opponentCards/);
  assert.match(onlineGameSource, /allPlayersOnline/);
  assert.match(onlineGameSource, /Every player must be online/);
  assert.match(onlineGameSource, /Round players no longer match/);
  assert.match(
    onlineGameSource,
    /참가자 접속을 확인할 수 없어 다음 판을 시작할 수 없어요\./,
  );
  assert.match(
    onlineGameSource,
    /2분 동안 게임 행동이 없어 게임이 자동 종료됐어요\./,
  );
});

test("dedicated game CSS keeps exact large-card responsive dimensions", () => {
  assert.match(globalStylesSource, /\.accountRoom--playing\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(globalStylesSource, /\.onlineGame\s*\{[\s\S]*?min-height:/);
  assert.match(globalStylesSource, /--my-card-w:\s*132px;/);
  assert.match(globalStylesSource, /--my-card-h:\s*194px;/);
  assert.match(globalStylesSource, /--opponent-card-w:\s*76px;/);
  assert.match(globalStylesSource, /--opponent-card-h:\s*112px;/);
  const mobile = globalStylesSource.match(
    /@media \(max-width: 680px\) \{[\s\S]*\n\}/,
  )?.[0];
  assert.ok(mobile);
  assert.match(mobile, /--my-card-w:\s*96px;/);
  assert.match(mobile, /--my-card-h:\s*142px;/);
  assert.match(mobile, /--opponent-card-w:\s*58px;/);
  assert.match(mobile, /--opponent-card-h:\s*86px;/);
  assert.match(globalStylesSource, /\.onlineGame__opponents\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(globalStylesSource, /\.onlineGame__actionDock\s*\{[\s\S]*?position:\s*sticky;/);
  assert.match(globalStylesSource, /min-height:\s*44px;/);
  assert.match(globalStylesSource, /overflow-x:\s*hidden;/);
});

test("short desktop gameplay keeps the action dock in the initial viewport", () => {
  const shortDesktop = globalStylesSource.match(
    /@media \(min-width: 681px\) and \(max-height: 800px\) \{[\s\S]*?\n\}/,
  )?.[0];

  assert.ok(shortDesktop);
  assert.match(shortDesktop, /\.online-shell:has\(\.onlineGame\)/);
  assert.match(
    shortDesktop,
    /\.onlineGame__me\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\);/,
  );
  assert.match(
    shortDesktop,
    /\.onlineGame__me \.onlineGame__rankRollup\s*\{[\s\S]*?grid-column:\s*3;[\s\S]*?grid-row:\s*2;/,
  );
  assert.match(
    shortDesktop,
    /\.onlineGame__actionDock\s*\{[\s\S]*?position:\s*sticky;/,
  );
});

test("room refreshes are account scoped and stale room work cannot mutate state", () => {
  assert.match(
    accountRoomSource,
    /const currentRoomIdRef = useRef<string \| null>\(null\);/,
  );
  assert.match(
    accountRoomSource,
    /const setCurrentRoom = useCallback\([\s\S]*?currentRoomIdRef\.current = nextRoom\?\.id \?\? null;[\s\S]*?setRoom\(nextRoom\);/,
  );
  const refreshRoomSource = accountRoomSource.match(
    /const refreshRoom = useCallback\([\s\S]*?\r?\n  \);\r?\n\r?\n  const refreshAccount/,
  )?.[0];
  assert.ok(refreshRoomSource);
  assert.match(refreshRoomSource, /const activeScope = scope \?\? captureAccountScope\(user\.id\);/);
  assert.match(refreshRoomSource, /if \(!isActiveAccount\(activeScope\)\) return;/);
  assert.match(refreshRoomSource, /const startingRoomId = currentRoomIdRef\.current;/);
  assert.match(
    refreshRoomSource,
    /await Promise\.all[\s\S]*?if \(\s*!isActiveAccount\(activeScope\) \|\|\s*currentRoomIdRef\.current !== startingRoomId\s*\) return;/,
  );
  assert.doesNotMatch(refreshRoomSource, /loadProfiles\([^)]*, scope\)/);
  assert.match(refreshRoomSource, /loadProfiles\([\s\S]*?activeScope/);
});

test("only the latest concurrent room refresh can update lobby state", () => {
  assert.match(
    accountRoomSource,
    /const roomRefreshRequestRef = useRef\(0\);/,
  );
  const refreshRoomSource = accountRoomSource.match(
    /const refreshRoom = useCallback\([\s\S]*?\r?\n  \);\r?\n\r?\n  const refreshAccount/,
  )?.[0];

  assert.ok(refreshRoomSource);
  assert.match(
    refreshRoomSource,
    /const refreshRequest = \+\+roomRefreshRequestRef\.current;/,
  );
  assert.match(
    refreshRoomSource,
    /if \(roomRefreshRequestRef\.current !== refreshRequest\) return;/,
  );
  assert.match(
    refreshRoomSource,
    /roomRefreshRequestRef\.current !== refreshRequest[\s\S]*?setCurrentRoom\(nextRoom\);/,
  );
});

test("realtime room subscriptions use stable IDs and reject late channel events", () => {
  assert.match(accountRoomSource, /const roomId = room\?\.id \?\? null;/);
  assert.match(
    accountRoomSource,
    /const isCurrentRoomChannel = \(\) =>\s*isActiveAccount\(scope\) && currentRoomIdRef\.current === roomId;/,
  );
  const subscriptionSource = accountRoomSource.match(
    /useEffect\(\(\) => \{\n    if \(!supabase \|\| !user\) return;[\s\S]*?\n  \}, \[[\s\S]*?\n  \]\);/,
  )?.[0];
  assert.ok(subscriptionSource);
  assert.match(subscriptionSource, /if \(!isCurrentRoomChannel\(\)\) return;/);
  assert.match(
    subscriptionSource,
    /if \(!isCurrentRoomChannel\(\)\) return;\s*returnToGameMain\(/,
  );
  const dependencies = subscriptionSource.slice(subscriptionSource.lastIndexOf("}, ["));
  assert.match(dependencies, /\broomId\b/);
  assert.doesNotMatch(dependencies, /\n    room,/);
});

test("room subscription closes the setup gap before deriving ready state", () => {
  const subscriptionSource = accountRoomSource.match(
    /useEffect\(\(\) => \{\n    if \(!supabase \|\| !user\) return;[\s\S]*?\n  \}, \[[\s\S]*?\n  \]\);/,
  )?.[0];

  assert.ok(subscriptionSource);
  assert.match(
    subscriptionSource,
    /const refreshActiveRoom = \(\) => \{[\s\S]*?if \(!roomId \|\| !isCurrentRoomChannel\(\)\) return;/,
  );
  assert.match(
    subscriptionSource,
    /channel\.subscribe\(\(status\) => \{[\s\S]*?status !== "SUBSCRIBED"[\s\S]*?refreshActiveRoom\(\);/,
  );
});

test("waiting rooms poll as a fallback when realtime changes are missed", () => {
  assert.match(
    accountRoomSource,
    /const LOBBY_REFRESH_INTERVAL_MS = 1_000;/,
  );
  assert.match(
    accountRoomSource,
    /if \(!supabase \|\| !user \|\| !roomId \|\| roomStatus !== "waiting"\) return;[\s\S]*?window\.setInterval\([\s\S]*?refreshRoom\(roomId, scope\)[\s\S]*?LOBBY_REFRESH_INTERVAL_MS/,
  );
  assert.match(
    accountRoomSource,
    /return \(\) => window\.clearInterval\(interval\);/,
  );
  assert.match(
    accountRoomSource,
    /const startingRoomId = currentRoomIdRef\.current;[\s\S]*?const refreshScope = `\$\{activeScope\.actorId\}:\$\{activeScope\.generation\}:\$\{startingRoomId \?\? "main"\}:\$\{roomId\}`;[\s\S]*?roomRefreshCoordinatorRef\.current\.run\([\s\S]*?refreshScope/,
  );
});

test("lifecycle polling prevents overlapping RPCs and coalesces room refreshes", () => {
  assert.match(onlineGameSource, /const touchInFlightGenerationRef = useRef<number \| null>\(null\);/);
  assert.match(onlineGameSource, /const expireInFlightGenerationRef = useRef<number \| null>\(null\);/);
  assert.match(onlineGameSource, /const refreshInFlightRef = useRef<\{[\s\S]*?promise: Promise<void>;/);
  assert.match(
    onlineGameSource,
    /if \(touchInFlightGenerationRef\.current === generation\) return;/,
  );
  assert.match(
    onlineGameSource,
    /if \(expireInFlightGenerationRef\.current === generation\) return;/,
  );
  assert.match(
    onlineGameSource,
    /refreshInFlightRef\.current\?\.generation === generation[\s\S]*?return refreshInFlightRef\.current\.promise;/,
  );
  assert.match(
    onlineGameSource,
    /finally \{[\s\S]*?touchInFlightGenerationRef\.current === generation[\s\S]*?touchInFlightGenerationRef\.current = null;/,
  );
  assert.match(
    onlineGameSource,
    /finally \{[\s\S]*?expireInFlightGenerationRef\.current === generation[\s\S]*?expireInFlightGenerationRef\.current = null;/,
  );
});

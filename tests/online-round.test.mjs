import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readPublicOnlineRound } from "../src/lib/game/online-round.mjs";

const onlineGameSource = await readFile(
  new URL("../src/components/online-room-game.tsx", import.meta.url),
  "utf8",
);
const accountRoomSource = await readFile(
  new URL("../src/components/account-room-panel.tsx", import.meta.url),
  "utf8",
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

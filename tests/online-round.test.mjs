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

test("accepts schema 2 public betting state without card data", () => {
  assert.deepEqual(readPublicOnlineRound(safeRound), safeRound);
  assert.equal(JSON.stringify(safeRound).includes("imageId"), false);
});

test("accepts schema 2 showdown evaluations and winner IDs", () => {
  assert.deepEqual(readPublicOnlineRound(showdownRound), showdownRound);
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
  ];

  for (const state of malformedStates) {
    assert.equal(readPublicOnlineRound(state), null);
  }
});

test("rejects unexpected public keys that could smuggle hidden card data", () => {
  assert.equal(readPublicOnlineRound({ ...safeRound, imageId: 1 }), null);
  assert.equal(
    readPublicOnlineRound({
      ...safeRound,
      betting: { ...safeRound.betting, cards: [1, 2] },
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

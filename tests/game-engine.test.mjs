import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  compareHands,
  createBettingState,
  createDeck,
  dealRound,
  evaluateHand,
  recordHit,
  settleRound,
  summarizeAccountLedger,
} from "../src/lib/game/engine.mjs";

const card = (month, bright = false, id) => ({
  month,
  bright,
  ...(id === undefined ? {} : { id }),
});

const rankedHands = [
  ["38광땡", [card(3, true), card(8, true)]],
  ["18광땡", [card(1, true), card(8, true)]],
  ["13광땡", [card(1, true), card(3, true)]],
  ...Array.from({ length: 10 }, (_, index) => {
    const month = 10 - index;
    return [`${month}땡`, [card(month), card(month)]];
  }),
  ["알리", [card(1), card(2)]],
  ["독사", [card(1), card(4)]],
  ["구삥", [card(1), card(9)]],
  ["장삥", [card(1), card(10)]],
  ["장사", [card(4), card(10)]],
  ["세륙", [card(4), card(6)]],
  ["갑오", [card(2), card(7)]],
  ["8끗", [card(2), card(6)]],
  ["7끗", [card(2), card(5)]],
  ["6끗", [card(1), card(5)]],
  ["5끗", [card(2), card(3)]],
  ["4끗", [card(1), card(3)]],
  ["3끗", [card(5), card(8)]],
  ["2끗", [card(5), card(7)]],
  ["1끗", [card(3), card(8)]],
  ["망통", [card(2), card(8)]],
];

test("createDeck constructs two stable cards per month and only three source bright cards", () => {
  const deck = createDeck();

  assert.equal(deck.length, 20);
  assert.equal(new Set(deck.map(({ id }) => id)).size, 20);
  assert.deepEqual(
    deck.map(({ imageId }) => imageId),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );

  for (let month = 1; month <= 10; month += 1) {
    const monthlyCards = deck.filter((candidate) => candidate.month === month);
    assert.deepEqual(
      monthlyCards.map(({ variant }) => variant),
      [1, 2],
    );
  }

  assert.deepEqual(
    deck.filter(({ bright }) => bright).map(({ imageId }) => imageId),
    [1, 5, 15],
  );
});

test("evaluateHand names and orders every standard hand tier", () => {
  const evaluated = rankedHands.map(([expectedName, cards]) => {
    const hand = evaluateHand(cards);
    assert.equal(hand.name, expectedName);
    assert.equal(typeof hand.rank, "number");
    assert.equal(typeof hand.tiebreak, "number");
    return hand;
  });

  for (let index = 0; index < evaluated.length - 1; index += 1) {
    assert.ok(
      compareHands(evaluated[index], evaluated[index + 1]) > 0,
      `${evaluated[index].name} should beat ${evaluated[index + 1].name}`,
    );
    assert.ok(compareHands(evaluated[index + 1], evaluated[index]) < 0);
  }
});

test("evaluateHand is independent of card order", () => {
  for (const [, cards] of rankedHands) {
    const forward = evaluateHand(cards);
    const reverse = evaluateHand([...cards].reverse());
    assert.deepEqual(reverse, forward);
    assert.deepEqual(forward.months, [...forward.months].sort((a, b) => a - b));
  }
});

test("compareHands returns zero for equivalent evaluated hands", () => {
  const first = evaluateHand([card(7, false, "7-1"), card(7, false, "7-2")]);
  const second = evaluateHand([card(7, false, "other-1"), card(7, false, "other-2")]);

  assert.equal(compareHands(first, second), 0);
});

test("evaluateHand rejects malformed and impossible hands", () => {
  assert.throws(() => evaluateHand(null), TypeError);
  assert.throws(() => evaluateHand([card(1)]), RangeError);
  assert.throws(() => evaluateHand([card(1), card(2), card(3)]), RangeError);
  assert.throws(() => evaluateHand([card(0), card(2)]), RangeError);
  assert.throws(() => evaluateHand([card(1.5), card(2)]), RangeError);
  assert.throws(() => evaluateHand([card(11), card(2)]), RangeError);
  assert.throws(() => evaluateHand([card(2, true), card(3)]), RangeError);
  assert.throws(
    () => evaluateHand([{ month: 1, bright: "yes" }, card(2)]),
    TypeError,
  );
  assert.throws(
    () => evaluateHand([card(1, true, "same"), card(1, false, "same")]),
    RangeError,
  );
});

test("dealRound is deterministic and deals unique cards to two players", () => {
  const first = dealRound(["alice", "bob"], () => 0);
  const second = dealRound(["alice", "bob"], () => 0);

  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), ["alice", "bob"]);
  assert.equal(first.alice.length, 2);
  assert.equal(first.bob.length, 2);
  assert.equal(new Set(Object.values(first).flat().map(({ id }) => id)).size, 4);
});

test("dealRound deals exactly two unique cards to four players", () => {
  let value = 0;
  const hands = dealRound(["a", "b", "c", "d"], () => {
    value = (value + 0.37) % 1;
    return value;
  });
  const dealtCards = Object.values(hands).flat();

  assert.deepEqual(
    Object.values(hands).map((hand) => hand.length),
    [2, 2, 2, 2],
  );
  assert.equal(new Set(dealtCards.map(({ id }) => id)).size, 8);
});

test("dealRound rejects invalid player sets and RNG results", () => {
  for (const players of [
    [],
    ["solo"],
    ["a", "b", "c", "d", "e"],
    ["a", "a"],
    ["a", ""],
    ["a", "   "],
    ["a", 2],
  ]) {
    assert.throws(() => dealRound(players));
  }
  assert.throws(() => dealRound("a,b"), TypeError);
  assert.throws(() => dealRound(["a", "b"], 1), TypeError);
  assert.throws(() => dealRound(["a", "b"], () => 1), RangeError);
});

test("createBettingState starts every player at zero commitment", () => {
  const state = createBettingState(["a", "b", "c"], 3, 1);

  assert.deepEqual(state.playerIds, ["a", "b", "c"]);
  assert.deepEqual(state.commitments, { a: 0, b: 0, c: 0 });
  assert.equal(state.currentStake, 3);
  assert.equal(state.pot, 0);
  assert.equal(state.turnPlayerId, "b");
  assert.equal(state.lastAggressorId, null);
  assert.equal(state.status, "betting");
  assert.deepEqual(state.foldedPlayerIds, []);
  assert.deepEqual(state.foldedStakes, {});
});

test("four-player call turns wrap and complete after every player acts", () => {
  let state = createBettingState(["a", "b", "c", "d"], 1, 2);
  const expectedTurns = ["c", "d", "a", "b"];

  for (const playerId of expectedTurns) {
    assert.equal(state.turnPlayerId, playerId);
    state = applyAction(state, playerId, { type: "call" });
  }

  assert.equal(state.status, "complete");
  assert.equal(state.turnPlayerId, null);
  assert.deepEqual(state.commitments, { a: 1, b: 1, c: 1, d: 1 });
  assert.equal(state.pot, 4);
});

test("two calls complete betting without mutating earlier states", () => {
  const initial = createBettingState(["a", "b"]);
  const afterFirstCall = applyAction(initial, "a", { type: "call" });
  const complete = applyAction(afterFirstCall, "b", { type: "call" });

  assert.deepEqual(initial.commitments, { a: 0, b: 0 });
  assert.deepEqual(afterFirstCall.commitments, { a: 1, b: 0 });
  assert.equal(afterFirstCall.turnPlayerId, "b");
  assert.equal(complete.status, "complete");
  assert.equal(complete.pot, 2);
});

test("a call upgrades a legacy active state without mutating its shape", () => {
  const legacyState = { ...createBettingState(["a", "b"]) };
  delete legacyState.foldedPlayerIds;
  delete legacyState.foldedStakes;

  const afterCall = applyAction(legacyState, "a", { type: "call" });

  assert.equal(Object.hasOwn(legacyState, "foldedPlayerIds"), false);
  assert.equal(Object.hasOwn(legacyState, "foldedStakes"), false);
  assert.deepEqual(legacyState.commitments, { a: 0, b: 0 });
  assert.equal(Object.hasOwn(afterCall, "foldedPlayerIds"), true);
  assert.equal(Object.hasOwn(afterCall, "foldedStakes"), true);
  assert.deepEqual(afterCall.foldedPlayerIds, []);
  assert.deepEqual(afterCall.foldedStakes, {});
  assert.deepEqual(afterCall.commitments, { a: 1, b: 0 });
  assert.equal(afterCall.turnPlayerId, "b");
});

test("a raise upgrades a legacy active state while preserving exact quantities", () => {
  const hugeStake = "900719925474099312345678901234567890";
  const legacyState = { ...createBettingState(["a", "b", "c"]) };
  delete legacyState.foldedPlayerIds;
  delete legacyState.foldedStakes;

  const afterRaise = applyAction(legacyState, "a", {
    type: "raise",
    amount: hugeStake,
  });

  assert.equal(Object.hasOwn(legacyState, "foldedPlayerIds"), false);
  assert.equal(Object.hasOwn(legacyState, "foldedStakes"), false);
  assert.equal(Object.hasOwn(afterRaise, "foldedPlayerIds"), true);
  assert.equal(Object.hasOwn(afterRaise, "foldedStakes"), true);
  assert.deepEqual(afterRaise.foldedPlayerIds, []);
  assert.deepEqual(afterRaise.foldedStakes, {});
  assert.equal(afterRaise.currentStake, hugeStake);
  assert.equal(afterRaise.commitments.a, hugeStake);
  assert.equal(afterRaise.pot, hugeStake);
  assert.deepEqual(afterRaise.pendingPlayerIds, ["b", "c"]);
});

test("a raise resets required actions to every other player", () => {
  let state = createBettingState(["a", "b", "c", "d"]);
  state = applyAction(state, "a", { type: "call" });
  state = applyAction(state, "b", { type: "raise", amount: 7 });

  assert.equal(state.currentStake, 7);
  assert.equal(state.lastAggressorId, "b");
  assert.equal(state.turnPlayerId, "c");
  assert.deepEqual(state.pendingPlayerIds, ["c", "d", "a"]);

  for (const playerId of ["c", "d", "a"]) {
    state = applyAction(state, playerId, { type: "call" });
  }

  assert.equal(state.status, "complete");
  assert.deepEqual(state.commitments, { a: 7, b: 7, c: 7, d: 7 });
  assert.equal(state.pot, 28);
});

test("a fold freezes the current stake and a later raise skips the folded player", () => {
  const initial = createBettingState(["a", "b", "c", "d"]);
  const afterCall = applyAction(initial, "a", { type: "call" });
  const afterFirstRaise = applyAction(afterCall, "b", {
    type: "raise",
    amount: 7,
  });
  const afterFold = applyAction(afterFirstRaise, "c", { type: "fold" });
  const afterSecondRaise = applyAction(afterFold, "d", {
    type: "raise",
    amount: 9,
  });

  assert.deepEqual(afterFold.foldedPlayerIds, ["c"]);
  assert.deepEqual(afterFold.foldedStakes, { c: 7 });
  assert.equal(afterFold.commitments.c, 7);
  assert.equal(afterFold.pot, 15);
  assert.equal(afterFold.turnPlayerId, "d");
  assert.deepEqual(afterSecondRaise.pendingPlayerIds, ["a", "b"]);
  assert.equal(afterSecondRaise.turnPlayerId, "a");
  assert.equal(afterSecondRaise.commitments.c, 7);
  assert.equal(afterSecondRaise.foldedStakes.c, 7);

  const afterACall = applyAction(afterSecondRaise, "a", { type: "call" });
  const complete = applyAction(afterACall, "b", { type: "call" });

  assert.equal(complete.status, "complete");
  assert.equal(complete.turnPlayerId, null);
  assert.deepEqual(complete.pendingPlayerIds, []);
  assert.deepEqual(complete.commitments, { a: 9, b: 9, c: 7, d: 9 });
  assert.equal(complete.pot, 34);

  assert.deepEqual(initial.foldedPlayerIds, []);
  assert.deepEqual(initial.foldedStakes, {});
  assert.deepEqual(afterFirstRaise.foldedPlayerIds, []);
  assert.deepEqual(afterFirstRaise.foldedStakes, {});
  assert.deepEqual(afterFold.pendingPlayerIds, ["d", "a"]);
  assert.deepEqual(afterFold.foldedStakes, { c: 7 });
});

test("folding completes immediately when only one active player remains", () => {
  const initial = createBettingState(["a", "b"], 5);
  const complete = applyAction(initial, "a", { type: "fold" });

  assert.equal(complete.status, "complete");
  assert.equal(complete.turnPlayerId, null);
  assert.deepEqual(complete.pendingPlayerIds, []);
  assert.deepEqual(complete.foldedPlayerIds, ["a"]);
  assert.deepEqual(complete.foldedStakes, { a: 5 });
  assert.deepEqual(complete.commitments, { a: 5, b: 0 });
  assert.equal(complete.pot, 5);
  assert.equal(initial.commitments.a, 0);
  assert.deepEqual(initial.foldedPlayerIds, []);
  assert.deepEqual(initial.foldedStakes, {});
});

test("four-player folds retain original seat order rather than action order", () => {
  let state = createBettingState(["a", "b", "c", "d"], 1, 2);
  state = applyAction(state, "c", { type: "fold" });
  state = applyAction(state, "d", { type: "call" });
  state = applyAction(state, "a", { type: "fold" });

  assert.deepEqual(state.foldedPlayerIds, ["a", "c"]);
  assert.deepEqual(state.foldedStakes, { c: 1, a: 1 });
  assert.deepEqual(state.pendingPlayerIds, ["b"]);
  assert.equal(state.turnPlayerId, "b");

  state = applyAction(state, "b", { type: "call" });
  assert.equal(state.status, "complete");
  assert.deepEqual(state.commitments, { a: 1, b: 1, c: 1, d: 1 });
});

test("folded stakes preserve arbitrary precision through later raises", () => {
  const hugeStake = "900719925474099312345678901234567890";
  const higherStake = "900719925474099312345678901234567999";
  const afterFold = applyAction(
    createBettingState(["a", "b", "c"], hugeStake),
    "a",
    { type: "fold" },
  );
  const afterRaise = applyAction(afterFold, "b", {
    type: "raise",
    amount: higherStake,
  });

  assert.equal(afterFold.foldedStakes.a, hugeStake);
  assert.equal(afterFold.commitments.a, hugeStake);
  assert.equal(afterFold.pot, hugeStake);
  assert.equal(afterRaise.foldedStakes.a, hugeStake);
  assert.equal(afterRaise.commitments.a, hugeStake);
  assert.deepEqual(afterRaise.pendingPlayerIds, ["c"]);
  assert.doesNotThrow(() => JSON.stringify(afterRaise));
});

test("raise amount is exact above Number.MAX_SAFE_INTEGER and remains JSON serializable", () => {
  const hugeStake = "900719925474099312345678901234567890";
  const raised = applyAction(
    createBettingState(["a", "b"]),
    "a",
    { type: "raise", amount: hugeStake },
  );
  const complete = applyAction(raised, "b", { type: "call" });

  assert.equal(raised.currentStake, hugeStake);
  assert.equal(raised.commitments.a, hugeStake);
  assert.equal(raised.pot, hugeStake);
  assert.deepEqual(complete.commitments, { a: hugeStake, b: hugeStake });
  assert.equal(complete.pot, "1801439850948198624691357802469135780");
  assert.doesNotThrow(() => JSON.stringify(complete));
});

test("normal-sized number stakes remain numbers for existing UI consumers", () => {
  const raised = applyAction(
    createBettingState(["a", "b"], 3),
    "a",
    { type: "raise", amount: 7n },
  );

  assert.equal(raised.currentStake, 7);
  assert.equal(raised.commitments.a, 7);
  assert.equal(raised.pot, 7);
});

test("betting rejects invalid setup, out-of-turn, unsupported, and invalid actions", () => {
  assert.throws(() => createBettingState(["a"]), RangeError);
  assert.throws(() => createBettingState(["a", "a"]), RangeError);
  assert.throws(() => createBettingState(["a", "b"], 0), RangeError);
  assert.throws(() => createBettingState(["a", "b"], 1.5), RangeError);
  assert.throws(() => createBettingState(["a", "b"], 1, -1), RangeError);
  assert.throws(() => createBettingState(["a", "b"], 1, 2), RangeError);

  const state = createBettingState(["a", "b"]);
  assert.throws(() => applyAction(state, "b", { type: "call" }), RangeError);
  assert.throws(
    () => applyAction(state, "a", { type: "check" }),
    /action type must be call, raise, or fold/,
  );
  assert.throws(() => applyAction(state, "a", null), TypeError);
  for (const amount of [
    1,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1.5",
    "-2",
    "",
  ]) {
    assert.throws(() => applyAction(state, "a", { type: "raise", amount }));
  }

  const complete = applyAction(
    applyAction(state, "a", { type: "call" }),
    "b",
    { type: "call" },
  );
  assert.throws(() => applyAction(complete, "a", { type: "call" }), RangeError);
});

test("applyAction rejects noncanonical or inconsistent rehydrated quantities", () => {
  const state = createBettingState(["a", "b"]);
  const malformedStates = [
    { ...state, currentStake: "1" },
    { ...state, currentStake: "01" },
    { ...state, pot: "0" },
    { ...state, pot: -1 },
    { ...state, pot: 1 },
    { ...state, commitments: { a: "0", b: 0 } },
    { ...state, commitments: { a: -1, b: 0 }, pot: -1 },
    { ...state, commitments: { a: 5, b: 0 } },
    { ...state, commitments: { a: 0 } },
    { ...state, commitments: { a: 0, b: 0, outsider: 0 } },
  ];

  for (const malformed of malformedStates) {
    assert.throws(
      () => applyAction(malformed, "a", { type: "call" }),
      /invalid betting state/,
    );
  }
});

test("applyAction rejects incoherent pending players, turn, and aggressor", () => {
  const state = createBettingState(["a", "b"]);
  const malformedStates = [
    { ...state, pendingPlayerIds: ["a", "a"] },
    { ...state, pendingPlayerIds: ["a", "outsider"] },
    { ...state, turnPlayerId: "b" },
    { ...state, pendingPlayerIds: [], turnPlayerId: null },
    {
      ...state,
      commitments: { a: 1, b: 0 },
      pot: 1,
      lastAggressorId: "a",
    },
    { ...state, lastAggressorId: "outsider" },
  ];

  for (const malformed of malformedStates) {
    assert.throws(
      () => applyAction(malformed, "a", { type: "call" }),
      /invalid betting state/,
    );
  }
});

test("applyAction rejects malformed rehydrated folded players and stakes", () => {
  const initial = createBettingState(["a", "b", "c", "d"]);
  const afterFold = applyAction(initial, "a", { type: "fold" });
  const missingFoldedPlayerIds = { ...initial };
  delete missingFoldedPlayerIds.foldedPlayerIds;
  const missingFoldedStakes = { ...initial };
  delete missingFoldedStakes.foldedStakes;
  const malformedStates = [
    missingFoldedPlayerIds,
    missingFoldedStakes,
    { ...initial, foldedPlayerIds: null },
    { ...initial, foldedPlayerIds: ["a", "a"], foldedStakes: { a: 1 } },
    {
      ...initial,
      foldedPlayerIds: ["outsider"],
      foldedStakes: { outsider: 1 },
    },
    {
      ...initial,
      foldedPlayerIds: ["c", "a"],
      foldedStakes: { a: 1, c: 1 },
      commitments: { a: 1, b: 0, c: 1, d: 0 },
      pot: 2,
      pendingPlayerIds: ["b", "d"],
      turnPlayerId: "b",
    },
    { ...initial, foldedStakes: null },
    { ...initial, foldedStakes: [] },
    { ...afterFold, foldedStakes: {} },
    { ...afterFold, foldedStakes: { a: 1, b: 1 } },
    { ...afterFold, foldedStakes: { a: "1" } },
    { ...afterFold, foldedStakes: { a: 0 } },
    { ...afterFold, foldedStakes: { a: 2 } },
    {
      ...afterFold,
      foldedStakes: { a: 1 },
      commitments: { ...afterFold.commitments, a: 0 },
      pot: 0,
    },
    {
      ...afterFold,
      pendingPlayerIds: ["a", "b", "c", "d"],
      turnPlayerId: "a",
    },
    { ...afterFold, turnPlayerId: "a" },
    {
      ...initial,
      foldedPlayerIds: ["a", "b", "c", "d"],
      foldedStakes: { a: 1, b: 1, c: 1, d: 1 },
      commitments: { a: 1, b: 1, c: 1, d: 1 },
      pot: 4,
      pendingPlayerIds: [],
      turnPlayerId: null,
      status: "complete",
    },
  ];

  for (const malformed of malformedStates) {
    assert.throws(
      () => applyAction(malformed, malformed.turnPlayerId ?? "a", { type: "call" }),
      /(?:invalid (?:complete )?betting state|state folded)/,
    );
  }
});

test("applyAction rejects inherited fold fields in partially migrated states", () => {
  const canonical = createBettingState(["a", "b"]);
  const inheritedPlayerIds = Object.assign(
    Object.create({ foldedPlayerIds: [] }),
    canonical,
  );
  delete inheritedPlayerIds.foldedPlayerIds;
  const inheritedStakes = Object.assign(
    Object.create({ foldedStakes: {} }),
    canonical,
  );
  delete inheritedStakes.foldedStakes;

  assert.equal(Object.hasOwn(inheritedPlayerIds, "foldedPlayerIds"), false);
  assert.equal(Object.hasOwn(inheritedPlayerIds, "foldedStakes"), true);
  assert.equal(Object.hasOwn(inheritedStakes, "foldedPlayerIds"), true);
  assert.equal(Object.hasOwn(inheritedStakes, "foldedStakes"), false);
  assert.throws(
    () => applyAction(inheritedPlayerIds, "a", { type: "call" }),
    /invalid betting state/,
  );
  assert.throws(
    () => applyAction(inheritedStakes, "a", { type: "call" }),
    /invalid betting state/,
  );
});

test("applyAction rejects folded pending players and a folded last aggressor", () => {
  const initial = createBettingState(["a", "b", "c", "d"]);
  const raised = applyAction(initial, "a", { type: "raise", amount: 7 });
  const foldedAggressor = {
    ...raised,
    foldedPlayerIds: ["a"],
    foldedStakes: { a: 7 },
  };

  assert.throws(
    () => applyAction(foldedAggressor, "b", { type: "call" }),
    /invalid betting state/,
  );
});

test("applyAction rejects incoherent completed rehydrated states", () => {
  const initial = createBettingState(["a", "b"]);
  const complete = applyAction(
    applyAction(initial, "a", { type: "call" }),
    "b",
    { type: "call" },
  );
  const malformedStates = [
    { ...complete, turnPlayerId: "a" },
    { ...complete, pendingPlayerIds: ["a"], turnPlayerId: "a" },
    { ...complete, commitments: { a: 1, b: 0 }, pot: 1 },
    { ...complete, currentStake: 2 },
  ];

  for (const malformed of malformedStates) {
    assert.throws(
      () => applyAction(malformed, "a", { type: "call" }),
      /invalid complete betting state/,
    );
  }
});

test("settleRound retains opposite obligations and appends one per loser", () => {
  const existing = [
    {
      id: "old",
      debtorId: "winner",
      creditorId: "loser-1",
      initial: 3,
      remaining: 2,
      delivered: 1,
    },
  ];

  const settled = settleRound(existing, {
    winnerId: "winner",
    loserIds: ["loser-1", "loser-2"],
    stake: 5,
  });

  assert.deepEqual(existing, [
    {
      id: "old",
      debtorId: "winner",
      creditorId: "loser-1",
      initial: 3,
      remaining: 2,
      delivered: 1,
    },
  ]);
  assert.deepEqual(settled.slice(1), [
    {
      id: "obligation-1",
      debtorId: "loser-1",
      creditorId: "winner",
      initial: 5,
      remaining: 5,
      delivered: 0,
    },
    {
      id: "obligation-2",
      debtorId: "loser-2",
      creditorId: "winner",
      initial: 5,
      remaining: 5,
      delivered: 0,
    },
  ]);
});

test("settleRound appends nothing for a tie", () => {
  const obligations = [
    {
      id: "one",
      debtorId: "a",
      creditorId: "b",
      initial: 1,
      remaining: 1,
      delivered: 0,
    },
  ];

  assert.deepEqual(
    settleRound(obligations, { winnerId: null, loserIds: [], stake: 3 }),
    obligations,
  );
});

test("settleRound and recordHit preserve exact stakes above Number.MAX_SAFE_INTEGER", () => {
  const hugeStake = 900719925474099312345678901234567890n;
  const settled = settleRound([], {
    winnerId: "winner",
    loserIds: ["loser"],
    stake: hugeStake,
  });

  assert.deepEqual(settled[0], {
    id: "obligation-1",
    debtorId: "loser",
    creditorId: "winner",
    initial: hugeStake.toString(),
    remaining: hugeStake.toString(),
    delivered: 0,
  });

  const recorded = recordHit(settled, "obligation-1");
  assert.equal(recorded[0].remaining, (hugeStake - 1n).toString());
  assert.equal(recorded[0].delivered, 1);
  assert.doesNotThrow(() => JSON.stringify(recorded));
});

test("settleRound validates stake and account IDs", () => {
  const valid = { winnerId: "a", loserIds: ["b"], stake: 1 };
  assert.throws(() => settleRound(null, valid), TypeError);
  for (const stake of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => settleRound([], { ...valid, stake }));
  }
  assert.throws(() => settleRound([], { ...valid, winnerId: "" }));
  assert.throws(() => settleRound([], { ...valid, winnerId: "   " }));
  assert.throws(() => settleRound([], { ...valid, loserIds: [] }));
  assert.throws(() => settleRound([], { ...valid, loserIds: ["b", "b"] }));
  assert.throws(() => settleRound([], { ...valid, loserIds: ["a"] }));
  assert.throws(() => settleRound([], { ...valid, loserIds: [""] }));
});

test("recordHit changes only the selected directed obligation", () => {
  const obligations = [
    {
      id: "a-to-b",
      debtorId: "a",
      creditorId: "b",
      initial: 3,
      remaining: 2,
      delivered: 1,
    },
    {
      id: "b-to-a",
      debtorId: "b",
      creditorId: "a",
      initial: 5,
      remaining: 5,
      delivered: 0,
    },
  ];

  const recorded = recordHit(obligations, "a-to-b");

  assert.deepEqual(recorded[0], {
    ...obligations[0],
    remaining: 1,
    delivered: 2,
  });
  assert.deepEqual(recorded[1], obligations[1]);
  assert.equal(obligations[0].remaining, 2);
});

test("recordHit rejects missing and already-complete obligations", () => {
  const complete = [
    {
      id: "done",
      debtorId: "a",
      creditorId: "b",
      initial: 1,
      remaining: 0,
      delivered: 1,
    },
  ];

  assert.throws(() => recordHit(complete, "missing"), RangeError);
  assert.throws(() => recordHit(complete, "done"), RangeError);
  assert.throws(() => recordHit(complete, ""), TypeError);
});

test("summarizeAccountLedger totals directed balances and delivered hits", () => {
  const obligations = [
    {
      id: "a-to-b",
      debtorId: "a",
      creditorId: "b",
      initial: 5,
      remaining: 3,
      delivered: 2,
    },
    {
      id: "b-to-a",
      debtorId: "b",
      creditorId: "a",
      initial: 4,
      remaining: 1,
      delivered: 3,
    },
    {
      id: "a-to-c",
      debtorId: "a",
      creditorId: "c",
      initial: 2,
      remaining: 2,
      delivered: 0,
    },
  ];

  assert.deepEqual(summarizeAccountLedger(obligations, "a"), {
    owes: 5,
    isOwed: 1,
    hitsDelivered: 2,
    hitsReceived: 3,
  });
  assert.deepEqual(summarizeAccountLedger(obligations, "c"), {
    owes: 0,
    isOwed: 2,
    hitsDelivered: 0,
    hitsReceived: 0,
  });
  assert.throws(() => summarizeAccountLedger(obligations, ""), TypeError);
});

test("summarizeAccountLedger totals arbitrary-precision directed amounts exactly", () => {
  const huge = "900719925474099312345678901234567890";
  const obligations = [
    {
      id: "one",
      debtorId: "a",
      creditorId: "b",
      initial: huge,
      remaining: huge,
      delivered: huge,
    },
    {
      id: "two",
      debtorId: "a",
      creditorId: "c",
      initial: huge,
      remaining: huge,
      delivered: huge,
    },
  ];

  assert.deepEqual(summarizeAccountLedger(obligations, "a"), {
    owes: "1801439850948198624691357802469135780",
    isOwed: 0,
    hitsDelivered: "1801439850948198624691357802469135780",
    hitsReceived: 0,
  });
});

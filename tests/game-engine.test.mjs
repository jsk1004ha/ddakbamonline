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
  ["38광땅", [card(3, true), card(8, true)]],
  ["18광땅", [card(1, true), card(8, true)]],
  ["13광땅", [card(1, true), card(3, true)]],
  ...Array.from({ length: 10 }, (_, index) => {
    const month = 10 - index;
    return [`${month}땅`, [card(month), card(month)]];
  }),
  ["알리", [card(1), card(2)]],
  ["독사", [card(1), card(4)]],
  ["구삐", [card(1), card(9)]],
  ["장삐", [card(1), card(10)]],
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

test("raise amount has no game-defined upper bound", () => {
  const hugeStake = Number.MAX_SAFE_INTEGER;
  const state = applyAction(
    createBettingState(["a", "b"]),
    "a",
    { type: "raise", amount: hugeStake },
  );

  assert.equal(state.currentStake, hugeStake);
  assert.equal(state.commitments.a, hugeStake);
  assert.equal(state.pot, hugeStake);
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
  assert.throws(() => applyAction(state, "a", { type: "fold" }), RangeError);
  assert.throws(() => applyAction(state, "a", null), TypeError);
  for (const amount of [1, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => applyAction(state, "a", { type: "raise", amount }));
  }

  const complete = applyAction(
    applyAction(state, "a", { type: "call" }),
    "b",
    { type: "call" },
  );
  assert.throws(() => applyAction(complete, "a", { type: "call" }), RangeError);
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
    hitsDelivered: 3,
    hitsReceived: 2,
  });
  assert.deepEqual(summarizeAccountLedger(obligations, "c"), {
    owes: 0,
    isOwed: 2,
    hitsDelivered: 0,
    hitsReceived: 0,
  });
  assert.throws(() => summarizeAccountLedger(obligations, ""), TypeError);
});

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const BRIGHT_MONTHS = new Set([1, 3, 8]);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// Public quantities stay as numbers while safe and become canonical decimal
// strings above that range, keeping exact engine state JSON serializable.

const BRIGHT_HANDS = new Map([
  ["3,8", { name: "38광땡", tiebreak: 3 }],
  ["1,8", { name: "18광땡", tiebreak: 2 }],
  ["1,3", { name: "13광땡", tiebreak: 1 }],
]);

const SPECIAL_HANDS = new Map([
  ["1,2", { name: "알리", tiebreak: 6 }],
  ["1,4", { name: "독사", tiebreak: 5 }],
  ["1,9", { name: "구삥", tiebreak: 4 }],
  ["1,10", { name: "장삥", tiebreak: 3 }],
  ["4,10", { name: "장사", tiebreak: 2 }],
  ["4,6", { name: "세륙", tiebreak: 1 }],
]);

function isAccountId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireAccountId(value, label) {
  if (!isAccountId(value)) {
    throw new TypeError(`${label} must be a non-empty account ID`);
  }
}

function validatePlayerIds(playerIds) {
  if (!Array.isArray(playerIds)) {
    throw new TypeError("playerIds must be an array");
  }
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    throw new RangeError("playerIds must contain 2 to 4 accounts");
  }

  for (const playerId of playerIds) {
    requireAccountId(playerId, "playerId");
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new RangeError("playerIds must be unique");
  }
}

function parseExactInteger(value, label, allowZero = false) {
  let parsed;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${label} number must be a safe integer; use a decimal string or bigint for larger values`,
      );
    }
    parsed = BigInt(value);
  } else if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new RangeError(`${label} must be an unsigned decimal integer`);
    }
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${label} must be a number, decimal string, or bigint`);
  }

  if (allowZero ? parsed < 0n : parsed <= 0n) {
    throw new RangeError(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return parsed;
}

function serializeExactInteger(value) {
  return value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : value.toString();
}

function orderedFrom(playerIds, startingIndex) {
  return playerIds.map(
    (_, offset) => playerIds[(startingIndex + offset) % playerIds.length],
  );
}

export function createDeck() {
  return Array.from({ length: 20 }, (_, index) => {
    const imageId = index + 1;
    const month = Math.floor(index / 2) + 1;
    const variant = (index % 2) + 1;

    return {
      id: `card-${imageId}`,
      month,
      variant,
      imageId,
      bright: variant === 1 && BRIGHT_MONTHS.has(month),
    };
  });
}

export function dealRound(playerIds, rng = Math.random) {
  validatePlayerIds(playerIds);
  if (typeof rng !== "function") {
    throw new TypeError("rng must be a function");
  }

  const deck = createDeck();
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const randomValue = rng();
    if (
      typeof randomValue !== "number" ||
      !Number.isFinite(randomValue) ||
      randomValue < 0 ||
      randomValue >= 1
    ) {
      throw new RangeError("rng must return a number from 0 (inclusive) to 1 (exclusive)");
    }
    const swapIndex = Math.floor(randomValue * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  const hands = Object.fromEntries(playerIds.map((playerId) => [playerId, []]));
  let deckIndex = 0;
  for (let cardIndex = 0; cardIndex < 2; cardIndex += 1) {
    for (const playerId of playerIds) {
      hands[playerId].push(deck[deckIndex]);
      deckIndex += 1;
    }
  }
  return hands;
}

function normalizeHand(cards) {
  if (!Array.isArray(cards)) {
    throw new TypeError("cards must be an array");
  }
  if (cards.length !== 2) {
    throw new RangeError("a hand must contain exactly two cards");
  }

  const normalized = cards.map((candidate) => {
    if (candidate === null || typeof candidate !== "object") {
      throw new TypeError("each card must be an object");
    }
    if (
      !Number.isInteger(candidate.month) ||
      candidate.month < 1 ||
      candidate.month > 10
    ) {
      throw new RangeError("card month must be an integer from 1 to 10");
    }
    if (candidate.bright !== undefined && typeof candidate.bright !== "boolean") {
      throw new TypeError("card bright must be a boolean when provided");
    }

    const bright = candidate.bright === true;
    if (bright && !BRIGHT_MONTHS.has(candidate.month)) {
      throw new RangeError("only months 1, 3, and 8 can be bright");
    }
    if (candidate.id !== undefined) {
      requireAccountId(candidate.id, "card id");
    }

    return { month: candidate.month, bright, id: candidate.id };
  });

  if (
    normalized[0].id !== undefined &&
    normalized[0].id === normalized[1].id
  ) {
    throw new RangeError("a hand cannot contain the same card twice");
  }

  return normalized.sort((left, right) => left.month - right.month);
}

export function evaluateHand(cards) {
  const normalized = normalizeHand(cards);
  const months = normalized.map(({ month }) => month);
  const monthKey = months.join(",");

  if (normalized.every(({ bright }) => bright) && BRIGHT_HANDS.has(monthKey)) {
    const brightHand = BRIGHT_HANDS.get(monthKey);
    return { name: brightHand.name, rank: 3, tiebreak: brightHand.tiebreak, months };
  }

  if (months[0] === months[1]) {
    return {
      name: `${months[0]}땡`,
      rank: 2,
      tiebreak: months[0],
      months,
    };
  }

  if (SPECIAL_HANDS.has(monthKey)) {
    const specialHand = SPECIAL_HANDS.get(monthKey);
    return {
      name: specialHand.name,
      rank: 1,
      tiebreak: specialHand.tiebreak,
      months,
    };
  }

  const points = (months[0] + months[1]) % 10;
  return {
    name: points === 9 ? "갑오" : points === 0 ? "망통" : `${points}끗`,
    rank: 0,
    tiebreak: points,
    months,
  };
}

function validateEvaluatedHand(hand, label) {
  if (hand === null || typeof hand !== "object") {
    throw new TypeError(`${label} must be an evaluated hand`);
  }
  if (!Number.isFinite(hand.rank) || !Number.isFinite(hand.tiebreak)) {
    throw new TypeError(`${label} must contain numeric rank and tiebreak values`);
  }
}

export function compareHands(left, right) {
  validateEvaluatedHand(left, "left");
  validateEvaluatedHand(right, "right");

  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  return left.tiebreak - right.tiebreak;
}

export function createBettingState(
  playerIds,
  startingStake = 1,
  startingPlayerIndex = 0,
) {
  validatePlayerIds(playerIds);
  const exactStartingStake = parseExactInteger(startingStake, "startingStake");
  if (
    !Number.isInteger(startingPlayerIndex) ||
    startingPlayerIndex < 0 ||
    startingPlayerIndex >= playerIds.length
  ) {
    throw new RangeError("startingPlayerIndex must identify a player");
  }

  const players = [...playerIds];
  const pendingPlayerIds = orderedFrom(players, startingPlayerIndex);
  return {
    playerIds: players,
    commitments: Object.fromEntries(players.map((playerId) => [playerId, 0])),
    currentStake: serializeExactInteger(exactStartingStake),
    pot: 0,
    turnPlayerId: pendingPlayerIds[0],
    lastAggressorId: null,
    status: "betting",
    pendingPlayerIds,
  };
}

function validateBettingState(state) {
  if (state === null || typeof state !== "object") {
    throw new TypeError("state must be a betting state");
  }
  validatePlayerIds(state.playerIds);
  if (state.status !== "betting" && state.status !== "complete") {
    throw new RangeError("state has an invalid status");
  }
  if (
    state.commitments === null ||
    typeof state.commitments !== "object" ||
    Array.isArray(state.commitments)
  ) {
    throw new TypeError("state commitments are invalid");
  }
  if (!Array.isArray(state.pendingPlayerIds)) {
    throw new TypeError("state pending players are invalid");
  }

  const invalidState = (message, complete = false) => {
    throw new RangeError(
      `invalid ${complete ? "complete " : ""}betting state: ${message}`,
    );
  };
  const canonicalQuantity = (value, label, allowZero = false) => {
    let parsed;
    try {
      parsed = parseExactInteger(value, label, allowZero);
    } catch {
      invalidState(`${label} is not a valid exact integer`);
    }
    if (!Object.is(serializeExactInteger(parsed), value)) {
      invalidState(`${label} is not canonically serialized`);
    }
    return parsed;
  };

  const commitmentKeys = Object.keys(state.commitments);
  if (
    commitmentKeys.length !== state.playerIds.length ||
    commitmentKeys.some((playerId) => !state.playerIds.includes(playerId))
  ) {
    invalidState("commitment keys must exactly match playerIds");
  }

  const currentStake = canonicalQuantity(
    state.currentStake,
    "state currentStake",
  );
  const pot = canonicalQuantity(state.pot, "state pot", true);
  const commitments = Object.fromEntries(
    state.playerIds.map((playerId) => [
      playerId,
      canonicalQuantity(
        state.commitments[playerId],
        `commitment for ${playerId}`,
        true,
      ),
    ]),
  );

  if (
    state.playerIds.some((playerId) => commitments[playerId] > currentStake)
  ) {
    invalidState("a commitment cannot exceed currentStake");
  }
  const commitmentTotal = Object.values(commitments).reduce(
    (total, commitment) => total + commitment,
    0n,
  );
  if (pot !== commitmentTotal) {
    invalidState("pot must equal the sum of commitments");
  }

  const pendingPlayers = state.pendingPlayerIds;
  const pendingSet = new Set(pendingPlayers);
  if (
    pendingSet.size !== pendingPlayers.length ||
    pendingPlayers.some((playerId) => !state.playerIds.includes(playerId))
  ) {
    invalidState("pendingPlayerIds must be unique playerIds");
  }
  if (
    state.lastAggressorId !== null &&
    !state.playerIds.includes(state.lastAggressorId)
  ) {
    invalidState("lastAggressorId must be null or a playerId");
  }

  if (state.status === "complete") {
    if (
      state.turnPlayerId !== null ||
      pendingPlayers.length !== 0 ||
      state.playerIds.some(
        (playerId) => commitments[playerId] !== currentStake,
      )
    ) {
      invalidState(
        "turn must be null, pending must be empty, and all commitments must match",
        true,
      );
    }
  } else {
    if (
      pendingPlayers.length === 0 ||
      state.turnPlayerId !== pendingPlayers[0]
    ) {
      invalidState("turnPlayerId must equal the first pending player");
    }
    for (const playerId of state.playerIds) {
      const isPending = pendingSet.has(playerId);
      const coherentCommitment = isPending
        ? commitments[playerId] < currentStake
        : commitments[playerId] === currentStake;
      if (!coherentCommitment) {
        invalidState("commitments must agree with pendingPlayerIds");
      }
    }
  }

  if (
    state.lastAggressorId !== null &&
    (pendingSet.has(state.lastAggressorId) ||
      commitments[state.lastAggressorId] !== currentStake)
  ) {
    invalidState("lastAggressorId must be matched and outside pendingPlayerIds");
  }

  return { currentStake, pot, commitments };
}

export function applyAction(state, playerId, action) {
  const exactState = validateBettingState(state);
  requireAccountId(playerId, "playerId");
  if (state.status !== "betting") {
    throw new RangeError("betting is already complete");
  }
  if (playerId !== state.turnPlayerId) {
    throw new RangeError("only the turn player may act");
  }
  if (action === null || typeof action !== "object") {
    throw new TypeError("action must be an object");
  }

  const currentCommitment = exactState.commitments[playerId];

  if (action.type === "raise") {
    const amount = parseExactInteger(action.amount, "raise amount");
    if (amount <= exactState.currentStake) {
      throw new RangeError("raise amount must be an integer above the current stake");
    }

    const commitments = {
      ...state.commitments,
      [playerId]: serializeExactInteger(amount),
    };
    const playerIndex = state.playerIds.indexOf(playerId);
    const pendingPlayerIds = orderedFrom(
      state.playerIds,
      (playerIndex + 1) % state.playerIds.length,
    ).filter((candidateId) => candidateId !== playerId);

    return {
      ...state,
      commitments,
      currentStake: serializeExactInteger(amount),
      pot: serializeExactInteger(exactState.pot + amount - currentCommitment),
      turnPlayerId: pendingPlayerIds[0],
      lastAggressorId: playerId,
      status: "betting",
      pendingPlayerIds,
    };
  }

  if (action.type !== "call") {
    throw new RangeError("action type must be call or raise");
  }

  const commitments = {
    ...state.commitments,
    [playerId]: serializeExactInteger(exactState.currentStake),
  };
  const pendingPlayerIds = state.pendingPlayerIds.slice(1);
  const allMatched = state.playerIds.every(
    (candidateId) =>
      parseExactInteger(
        commitments[candidateId],
        `commitment for ${candidateId}`,
        true,
      ) === exactState.currentStake,
  );
  const complete = pendingPlayerIds.length === 0 && allMatched;

  return {
    ...state,
    commitments,
    pot: serializeExactInteger(
      exactState.pot + exactState.currentStake - currentCommitment,
    ),
    turnPlayerId: complete ? null : pendingPlayerIds[0],
    status: complete ? "complete" : "betting",
    pendingPlayerIds,
  };
}

function validateLoserIds(loserIds) {
  if (!Array.isArray(loserIds)) {
    throw new TypeError("loserIds must be an array");
  }
  for (const loserId of loserIds) {
    requireAccountId(loserId, "loserId");
  }
  if (new Set(loserIds).size !== loserIds.length) {
    throw new RangeError("loserIds must be unique");
  }
}

function nextObligationId(usedIds, counter) {
  let nextCounter = counter;
  let id = `obligation-${nextCounter}`;
  while (usedIds.has(id)) {
    nextCounter += 1;
    id = `obligation-${nextCounter}`;
  }
  usedIds.add(id);
  return { id, nextCounter: nextCounter + 1 };
}

export function settleRound(existingObligations, result) {
  if (!Array.isArray(existingObligations)) {
    throw new TypeError("existingObligations must be an array");
  }
  if (result === null || typeof result !== "object") {
    throw new TypeError("result must be an object");
  }

  const { winnerId, loserIds, stake } = result;
  const exactStake = parseExactInteger(stake, "stake");
  validateLoserIds(loserIds);

  if (winnerId === null) {
    return [...existingObligations];
  }

  requireAccountId(winnerId, "winnerId");
  if (loserIds.length === 0 || loserIds.length > MAX_PLAYERS - 1) {
    throw new RangeError("a settled win must have 1 to 3 losers");
  }
  if (loserIds.includes(winnerId)) {
    throw new RangeError("winnerId cannot also be a loserId");
  }

  const usedIds = new Set(
    existingObligations
      .map(({ id }) => id)
      .filter((id) => typeof id === "string"),
  );
  let counter = 1;
  const additions = loserIds.map((debtorId) => {
    const generated = nextObligationId(usedIds, counter);
    counter = generated.nextCounter;
    return {
      id: generated.id,
      debtorId,
      creditorId: winnerId,
      initial: serializeExactInteger(exactStake),
      remaining: serializeExactInteger(exactStake),
      delivered: 0,
    };
  });

  return [...existingObligations, ...additions];
}

export function recordHit(obligations, obligationId) {
  if (!Array.isArray(obligations)) {
    throw new TypeError("obligations must be an array");
  }
  requireAccountId(obligationId, "obligationId");

  const obligationIndex = obligations.findIndex(({ id }) => id === obligationId);
  if (obligationIndex === -1) {
    throw new RangeError("obligationId was not found");
  }

  const obligation = obligations[obligationIndex];
  const remaining = parseExactInteger(
    obligation.remaining,
    "obligation remaining",
    true,
  );
  if (remaining === 0n) {
    throw new RangeError("obligation is already complete");
  }
  const delivered = parseExactInteger(
    obligation.delivered,
    "obligation delivered",
    true,
  );

  return obligations.map((candidate, index) =>
    index === obligationIndex
      ? {
          ...candidate,
          remaining: serializeExactInteger(remaining - 1n),
          delivered: serializeExactInteger(delivered + 1n),
        }
      : candidate,
  );
}

export function summarizeAccountLedger(obligations, accountId) {
  if (!Array.isArray(obligations)) {
    throw new TypeError("obligations must be an array");
  }
  requireAccountId(accountId, "accountId");

  const exactSummary = obligations.reduce(
    (summary, obligation) => {
      const remaining = parseExactInteger(
        obligation.remaining,
        "obligation remaining",
        true,
      );
      const delivered = parseExactInteger(
        obligation.delivered,
        "obligation delivered",
        true,
      );
      if (obligation.debtorId === accountId) {
        summary.owes += remaining;
        summary.hitsDelivered += delivered;
      }
      if (obligation.creditorId === accountId) {
        summary.isOwed += remaining;
        summary.hitsReceived += delivered;
      }
      return summary;
    },
    { owes: 0n, isOwed: 0n, hitsDelivered: 0n, hitsReceived: 0n },
  );

  return Object.fromEntries(
    Object.entries(exactSummary).map(([key, value]) => [
      key,
      serializeExactInteger(value),
    ]),
  );
}

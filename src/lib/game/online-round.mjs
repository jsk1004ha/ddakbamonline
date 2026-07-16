const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const MAX_SAFE_EXACT_QUANTITY = BigInt(Number.MAX_SAFE_INTEGER);
const ROUND_KEYS = [
  "schema",
  "roundToken",
  "roundNumber",
  "playerIds",
  "foldedPlayerIds",
  "foldedStakes",
  "betting",
  "phase",
  "evaluations",
  "winnerIds",
];
const BETTING_KEYS = [
  "playerIds",
  "commitments",
  "currentStake",
  "pot",
  "turnPlayerId",
  "lastAggressorId",
  "status",
  "pendingPlayerIds",
];
const EVALUATION_KEYS = ["name", "rank", "tiebreak", "months"];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return false;
    }
  }

  return true;
}

function isPlainRecord(value) {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) {
    return false;
  }

  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
}

function isPlayerId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isPlayerList(value, minimum = 0, maximum = MAX_PLAYERS) {
  return (
    isCanonicalArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every(isPlayerId) &&
    new Set(value).size === value.length
  );
}

function samePlayerOrder(left, right) {
  return (
    left.length === right.length &&
    left.every((playerId, index) => playerId === right[index])
  );
}

function isOrderedPlayerSubset(value, playerIds) {
  if (
    !isPlayerList(value, 0, playerIds.length - 1) ||
    value.some((playerId) => !playerIds.includes(playerId))
  ) {
    return false;
  }

  const selectedPlayers = new Set(value);
  return samePlayerOrder(
    value,
    playerIds.filter((playerId) => selectedPlayers.has(playerId)),
  );
}

function parseExactQuantity(value, allowZero) {
  let quantity;

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      return null;
    }
    quantity = BigInt(value);
  } else if (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)$/.test(value)
  ) {
    quantity = BigInt(value);
    if (quantity <= MAX_SAFE_EXACT_QUANTITY) {
      return null;
    }
  } else {
    return null;
  }

  if (allowZero ? quantity < 0n : quantity <= 0n) {
    return null;
  }
  return quantity;
}

function readBetting(value, playerIds, foldedPlayerIds, foldedStakes) {
  if (!hasExactKeys(value, BETTING_KEYS)) {
    return null;
  }
  if (
    !isPlayerList(value.playerIds, MIN_PLAYERS) ||
    !samePlayerOrder(value.playerIds, playerIds) ||
    !isRecord(value.commitments)
  ) {
    return null;
  }

  const commitmentKeys = Object.keys(value.commitments);
  if (
    commitmentKeys.length !== playerIds.length ||
    commitmentKeys.some((playerId) => !playerIds.includes(playerId))
  ) {
    return null;
  }

  const currentStake = parseExactQuantity(value.currentStake, false);
  const pot = parseExactQuantity(value.pot, true);
  if (currentStake === null || pot === null) {
    return null;
  }

  const commitments = new Map();
  let commitmentTotal = 0n;
  for (const playerId of playerIds) {
    const commitment = parseExactQuantity(value.commitments[playerId], true);
    if (commitment === null || commitment > currentStake) {
      return null;
    }
    commitments.set(playerId, commitment);
    commitmentTotal += commitment;
  }
  if (commitmentTotal !== pot) {
    return null;
  }

  if (!isPlainRecord(foldedStakes)) {
    return null;
  }
  const foldedStakeKeys = Object.keys(foldedStakes);
  if (
    foldedStakeKeys.length !== foldedPlayerIds.length ||
    foldedStakeKeys.some((playerId) => !foldedPlayerIds.includes(playerId))
  ) {
    return null;
  }
  for (const playerId of foldedPlayerIds) {
    const foldedStake = parseExactQuantity(foldedStakes[playerId], false);
    if (
      foldedStake === null ||
      foldedStake > currentStake ||
      foldedStake !== commitments.get(playerId)
    ) {
      return null;
    }
  }

  const foldedPlayers = new Set(foldedPlayerIds);
  const activePlayerIds = playerIds.filter(
    (playerId) => !foldedPlayers.has(playerId),
  );

  if (
    !isPlayerList(value.pendingPlayerIds) ||
    value.pendingPlayerIds.some(
      (playerId) => !activePlayerIds.includes(playerId),
    ) ||
    !(
      value.lastAggressorId === null ||
      activePlayerIds.includes(value.lastAggressorId)
    )
  ) {
    return null;
  }

  const pendingPlayers = new Set(value.pendingPlayerIds);
  if (value.status === "betting") {
    if (
      activePlayerIds.length < MIN_PLAYERS ||
      value.pendingPlayerIds.length === 0 ||
      value.turnPlayerId !== value.pendingPlayerIds[0]
    ) {
      return null;
    }
    for (const playerId of activePlayerIds) {
      const commitment = commitments.get(playerId);
      if (pendingPlayers.has(playerId) !== (commitment < currentStake)) {
        return null;
      }
    }
  } else if (value.status === "complete") {
    if (
      value.turnPlayerId !== null ||
      value.pendingPlayerIds.length !== 0 ||
      (activePlayerIds.length > 1 &&
        activePlayerIds.some(
          (playerId) => commitments.get(playerId) !== currentStake,
        ))
    ) {
      return null;
    }
  } else {
    return null;
  }

  if (
    value.lastAggressorId !== null &&
    (pendingPlayers.has(value.lastAggressorId) ||
      commitments.get(value.lastAggressorId) !== currentStake)
  ) {
    return null;
  }

  return value;
}

function readEvaluation(value) {
  if (
    !hasExactKeys(value, EVALUATION_KEYS) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    !Number.isInteger(value.rank) ||
    value.rank < 0 ||
    value.rank > 3 ||
    !Number.isInteger(value.tiebreak) ||
    value.tiebreak < 0 ||
    !isCanonicalArray(value.months) ||
    value.months.length !== 2 ||
    value.months.some(
      (month) => !Number.isInteger(month) || month < 1 || month > 10,
    ) ||
    value.months[0] > value.months[1]
  ) {
    return null;
  }

  return value;
}

function readShowdown(evaluations, winnerIds, playerIds, activePlayerIds) {
  if (!isRecord(evaluations) || !isPlayerList(winnerIds, 1)) {
    return false;
  }
  if (
    Object.keys(evaluations).length !== playerIds.length ||
    Object.keys(evaluations).some((playerId) => !playerIds.includes(playerId)) ||
    winnerIds.some((playerId) => !activePlayerIds.includes(playerId))
  ) {
    return false;
  }

  const parsedEvaluations = new Map();
  for (const playerId of playerIds) {
    const evaluation = readEvaluation(evaluations[playerId]);
    if (evaluation === null) {
      return false;
    }
    parsedEvaluations.set(playerId, evaluation);
  }

  const strongest = activePlayerIds.reduce((best, playerId) => {
    const candidate = parsedEvaluations.get(playerId);
    if (
      best === null ||
      candidate.rank > best.rank ||
      (candidate.rank === best.rank && candidate.tiebreak > best.tiebreak)
    ) {
      return candidate;
    }
    return best;
  }, null);
  const expectedWinnerIds = activePlayerIds.filter((playerId) => {
    const candidate = parsedEvaluations.get(playerId);
    return (
      candidate.rank === strongest.rank &&
      candidate.tiebreak === strongest.tiebreak
    );
  });

  return (
    winnerIds.length === expectedWinnerIds.length &&
    winnerIds.every((playerId) => expectedWinnerIds.includes(playerId))
  );
}

export function readPublicOnlineRound(value) {
  if (
    !hasExactKeys(value, ROUND_KEYS) ||
    Object.hasOwn(value, "hands") ||
    value.schema !== 2 ||
    typeof value.roundToken !== "string" ||
    !UUID_PATTERN.test(value.roundToken) ||
    !Number.isSafeInteger(value.roundNumber) ||
    value.roundNumber < 1 ||
    !isPlayerList(value.playerIds, MIN_PLAYERS) ||
    !isOrderedPlayerSubset(value.foldedPlayerIds, value.playerIds)
  ) {
    return null;
  }

  const betting = readBetting(
    value.betting,
    value.playerIds,
    value.foldedPlayerIds,
    value.foldedStakes,
  );
  if (
    betting === null ||
    !isRecord(value.evaluations) ||
    !isCanonicalArray(value.winnerIds)
  ) {
    return null;
  }

  const foldedPlayers = new Set(value.foldedPlayerIds);
  const activePlayerIds = value.playerIds.filter(
    (playerId) => !foldedPlayers.has(playerId),
  );

  if (value.phase === "betting") {
    return betting.status === "betting" &&
      Object.keys(value.evaluations).length === 0 &&
      value.winnerIds.length === 0
      ? value
      : null;
  }

  if (value.phase === "showdown") {
    return betting.status === "complete" &&
      readShowdown(
        value.evaluations,
        value.winnerIds,
        value.playerIds,
        activePlayerIds,
      )
      ? value
      : null;
  }

  return null;
}

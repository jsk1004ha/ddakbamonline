import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

import {
  runCleanupSteps,
  throwQaOrCleanupError,
} from "./live-authority-cleanup.mjs";

const requiredEnv = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "QA_PASSWORD",
];

for (const name of requiredEnv) {
  assert.ok(process.env[name], `${name} is required`);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const qaPassword = process.env.QA_PASSWORD;
const internalDomain = "accounts.ddakbamonline.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BETTING_ACTIONS = 16;
const MAX_AUTH_USER_PAGES = 100;
const AUTH_USERS_PER_PAGE = 1_000;
const PRESENCE_BACKDATE_MS = 2 * 60_000;
const IDLE_BACKDATE_MS = 5 * 60_000;
const qaNamespace = crypto.randomUUID().replaceAll("-", "");
const qaSuffix = qaNamespace.slice(0, 5);
const hostAccountId = `qa_host_${qaSuffix}`;
const guestAccountId = `qa_guest_${qaSuffix}`;
const guestTwoAccountId = `qa_guest_two_${qaSuffix}`;
const guestThreeAccountId = `qa_guest_three_${qaSuffix}`;
const observerAccountId = `qa_watch_${qaSuffix}`;
const qaAccountIds = [
  hostAccountId,
  guestAccountId,
  guestTwoAccountId,
  guestThreeAccountId,
  observerAccountId,
];
const qaEmails = qaAccountIds.map(
  (accountId) => `${accountId}@${internalDomain}`,
);
const qaEmailSet = new Set(qaEmails);
const qaRoomCodes = [0, 1, 2].map((index) =>
  `Q${qaNamespace.slice(5 + index * 5, 10 + index * 5)}`
    .toUpperCase()
    .replace(/[01]/g, "A"),
);
const qaRoomCodeSet = new Set(qaRoomCodes);
assert.equal(qaRoomCodeSet.size, qaRoomCodes.length);
let qaRoomCodeIndex = 0;
let offlineRpcResponseBody = null;

async function fetchWithTimeout(input, init = {}) {
  const abortController = new AbortController();
  const upstreamSignal =
    init.signal ?? (input instanceof Request ? input.signal : null);
  const forwardAbort = () => abortController.abort(upstreamSignal.reason);
  if (upstreamSignal?.aborted) {
    forwardAbort();
  } else {
    upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeoutId = setTimeout(() => {
    abortController.abort(
      new DOMException(
        `Supabase request exceeded ${REQUEST_TIMEOUT_MS}ms`,
        "AbortError",
      ),
    );
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, { ...init, signal: abortController.signal });
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function fetchWithOfflineCapture(input, init) {
  const response = await fetchWithTimeout(input, init);
  if (String(input).includes("/rpc/add_offline_hit_obligation")) {
    offlineRpcResponseBody = await response.clone().text();
  }
  return response;
}

function client({ captureOfflineRpc = false } = {}) {
  const options = {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: captureOfflineRpc ? fetchWithOfflineCapture : fetchWithTimeout,
    },
  };
  return createClient(url, key, options);
}

const host = client({ captureOfflineRpc: true });
const guest = client();
const guestTwo = client();
const guestThree = client();
const observer = client();
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});
const createdUserIds = [];
const createdRoomIds = [];
const resultIds = [];
const obligationIds = [];
const offlineObligationIds = [];
const participantClients = new Map();

async function provisionQaUser(accountId) {
  const email = `${accountId}@${internalDomain}`;
  assert.ok(qaEmailSet.has(email), "QA user email was not pre-registered");
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: qaPassword,
    email_confirm: true,
    user_metadata: { account_id: accountId, display_name: accountId },
  });
  assert.ifError(error);
  assert.ok(data.user?.id);
  createdUserIds.push(data.user.id);
  return data.user.id;
}

function trackUnique(ids, id) {
  if (id && !ids.includes(id)) ids.push(id);
  return id;
}

async function discoverQaNamespaceUsers() {
  const namespaceUsers = [];
  let page = 1;
  for (let pageCount = 0; pageCount < MAX_AUTH_USER_PAGES; pageCount += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PER_PAGE,
    });
    assert.ifError(error);
    for (const user of data.users) {
      if (qaEmailSet.has(user.email)) namespaceUsers.push(user);
    }
    if (data.nextPage === null) return namespaceUsers;
    page = data.nextPage;
  }
  assert.fail(`QA Auth namespace exceeds ${MAX_AUTH_USER_PAGES} pages`);
}

function trackResultRows(rows) {
  for (const row of rows ?? []) {
    if (row.id && !resultIds.includes(row.id)) resultIds.push(row.id);
  }
  return rows ?? [];
}

function trackObligationRows(rows) {
  for (const row of rows ?? []) {
    if (row.id && !obligationIds.includes(row.id)) obligationIds.push(row.id);
  }
  return rows ?? [];
}

async function discoverCleanupTargets() {
  const namespaceUsers = await discoverQaNamespaceUsers();
  for (const user of namespaceUsers) {
    trackUnique(createdUserIds, user.id);
  }

  if (createdUserIds.length > 0) {
    const { data: namespaceRooms, error: namespaceRoomsError } = await admin
      .from("game_rooms")
      .select("id, code")
      .in("code", qaRoomCodes)
      .in("host_id", createdUserIds);
    assert.ifError(namespaceRoomsError);
    for (const room of namespaceRooms) {
      assert.ok(qaRoomCodeSet.has(room.code));
      trackUnique(createdRoomIds, room.id);
    }

    const { data: namespaceObligations, error: namespaceObligationsError } =
      await admin
        .from("hit_obligations")
        .select("id")
        .in("created_by", createdUserIds);
    assert.ifError(namespaceObligationsError);
    trackObligationRows(namespaceObligations);
  }

  if (createdRoomIds.length > 0) {
    const { data: results, error: resultError } = await admin
      .from("game_results")
      .select("id")
      .in("room_id", createdRoomIds);
    assert.ifError(resultError);
    trackResultRows(results);

    const { data: roomObligations, error: roomObligationsError } = await admin
      .from("hit_obligations")
      .select("id")
      .in("room_id", createdRoomIds);
    assert.ifError(roomObligationsError);
    trackObligationRows(roomObligations);
  }

  if (resultIds.length > 0) {
    const { data: resultObligations, error: resultObligationsError } =
      await admin
        .from("hit_obligations")
        .select("id")
        .in("game_result_id", resultIds);
    assert.ifError(resultObligationsError);
    trackObligationRows(resultObligations);
  }
}

async function assertNoQaResidue() {
  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id, account_id")
    .in("account_id", qaAccountIds);
  assert.ifError(profileError);
  assert.equal(profiles.length, 0, "QA namespace profiles remain");

  if (createdUserIds.length > 0) {
    const authLookups = await Promise.all(
      createdUserIds.map((userId) => admin.auth.admin.getUserById(userId)),
    );
    for (const lookup of authLookups) {
      assert.equal(lookup.data.user, null);
      assert.ok(lookup.error, "deleted auth user lookup should fail");
      assert.equal(lookup.error.name, "AuthApiError");
      assert.equal(lookup.error.status, 404);
      assert.equal(lookup.error.code, "user_not_found");
    }
  }

  const { data: rooms, error: roomError } = await admin
    .from("game_rooms")
    .select("id, code")
    .in("code", qaRoomCodes);
  assert.ifError(roomError);
  assert.equal(rooms.length, 0, "QA namespace rooms remain");

  if (resultIds.length > 0) {
    const { data: results, error: resultError } = await admin
      .from("game_results")
      .select("id")
      .in("id", resultIds);
    assert.ifError(resultError);
    assert.equal(results.length, 0, "disposable game results remain");
  }

  if (obligationIds.length > 0) {
    const { data: obligations, error: obligationError } = await admin
      .from("hit_obligations")
      .select("id")
      .in("id", obligationIds);
    assert.ifError(obligationError);
    assert.equal(obligations.length, 0, "disposable obligations remain");
  }

  const namespaceUsers = await discoverQaNamespaceUsers();
  assert.equal(namespaceUsers.length, 0, "QA namespace Auth users remain");
}

async function cleanupQaData() {
  const cleanupSteps = [
    {
      label: "generated row discovery",
      run: discoverCleanupTargets,
    },
    {
      label: "offline obligations",
      run: async () => {
        if (offlineObligationIds.length === 0) return;
        assert.ifError(
          (
            await admin
              .from("hit_obligations")
              .delete()
              .in("id", offlineObligationIds)
          ).error,
        );
      },
    },
    {
      label: "tracked obligations",
      run: async () => {
        if (obligationIds.length === 0) return;
        assert.ifError(
          (
            await admin
              .from("hit_obligations")
              .delete()
              .in("id", obligationIds)
          ).error,
        );
      },
    },
    {
      label: "game results",
      run: async () => {
        if (resultIds.length === 0) return;
        assert.ifError(
          (await admin.from("game_results").delete().in("id", resultIds)).error,
        );
      },
    },
    {
      label: "rooms",
      run: async () => {
        if (createdRoomIds.length === 0) return;
        assert.ifError(
          (await admin.from("game_rooms").delete().in("id", createdRoomIds))
            .error,
        );
      },
    },
  ];

  cleanupSteps.push({
    label: "disposable auth users",
    run: async () => {
      const userIds = [...createdUserIds].reverse();
      const deleteResults = await Promise.all(
        userIds.map((userId) => admin.auth.admin.deleteUser(userId)),
      );
      const deleteErrors = deleteResults
        .map(({ error }) => error)
        .filter(Boolean);
      if (deleteErrors.length > 0) {
        throw new AggregateError(deleteErrors, "failed to delete QA Auth users");
      }
    },
  });

  cleanupSteps.push({
    label: "zero residue verification",
    run: async () => {
      await assertNoQaResidue();
    },
  });

  await runCleanupSteps(cleanupSteps);
}

function expectError(result, label) {
  assert.ok(result.error, `${label} should be rejected`);
}

function expectErrorMessage(result, pattern, label) {
  expectError(result, label);
  assert.match(
    `${result.error.message ?? ""} ${result.error.details ?? ""} ${result.error.hint ?? ""}`,
    pattern,
    `${label} returned an unexpected server error`,
  );
}

function expectRejectedOfflineRpc(result, label) {
  const rows = Array.isArray(result.data) ? result.data : [result.data];
  for (const row of rows) {
    if (row?.id) {
      offlineObligationIds.push(row.id);
      trackUnique(obligationIds, row.id);
    }
  }
  expectError(result, label);
}

function assertExactNumericField(json, field, expected) {
  assert.ok(json, "expected the raw offline RPC response body");
  assert.match(
    json,
    new RegExp(`"${field}"\\s*:\\s*${expected}(?=\\s*[,}])`),
    `${field} lost integer precision in the RPC response`,
  );
}

function assertPublicState(state) {
  assert.equal(Number(state.schema), 2);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('"hands"'), "public state exposed hands");
  assert.ok(!serialized.includes('"cardIds"'), "public state exposed card IDs");
  assert.ok(!serialized.includes('"imageId"'), "public state exposed image IDs");
}

function actorClient(userId) {
  const supabase = participantClients.get(userId);
  if (supabase) return supabase;
  throw new Error("turn player was not a room member");
}

async function signIn(supabase, accountId) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: `${accountId}@${internalDomain}`,
    password: qaPassword,
  });
  assert.ifError(error);
  assert.ok(data.user?.id);
  return data.user.id;
}

async function readRoom(roomId) {
  const { data, error } = await host
    .from("game_rooms")
    .select("*")
    .eq("id", roomId)
    .single();
  assert.ifError(error);
  return data;
}

async function readRoomAsAdmin(roomId) {
  const { data, error } = await admin
    .from("game_rooms")
    .select("*")
    .eq("id", roomId)
    .single();
  assert.ifError(error);
  return data;
}

async function readMemberCount(roomId) {
  const { count, error } = await admin
    .from("room_members")
    .select("*", { count: "exact", head: true })
    .eq("room_id", roomId);
  assert.ifError(error);
  return count;
}

function nextRoomCode() {
  const roomCode = qaRoomCodes[qaRoomCodeIndex];
  assert.ok(roomCode, "QA room code registry exhausted");
  qaRoomCodeIndex += 1;
  return roomCode;
}

async function createReadyRoom(players) {
  const { data: createdRoom, error: roomError } = await host
    .from("game_rooms")
    .insert({
      code: nextRoomCode(),
      host_id: players[0].userId,
      max_players: players.length,
    })
    .select("*")
    .single();
  assert.ifError(roomError);
  createdRoomIds.push(createdRoom.id);

  for (const [seat, player] of players.entries()) {
    assert.ifError(
      (
        await player.supabase.from("room_members").insert({
          room_id: createdRoom.id,
          user_id: player.userId,
          seat,
        })
      ).error,
    );
    assert.ifError(
      (
        await player.supabase
          .from("room_members")
          .update({ ready: true })
          .eq("room_id", createdRoom.id)
          .eq("user_id", player.userId)
      ).error,
    );
  }
  return createdRoom;
}

async function touchParticipants(roomId, players) {
  const touches = await Promise.all(
    players.map(({ supabase }) =>
      supabase.rpc("touch_room_presence", { target_room: roomId }),
    ),
  );
  for (const touch of touches) assert.ifError(touch.error);
}

async function createActiveRoom(players) {
  const waitingRoom = await createReadyRoom(players);
  await touchParticipants(waitingRoom.id, players);
  assert.ifError(
    (
      await host.rpc("start_game_round", {
        target_room: waitingRoom.id,
        expected_version: waitingRoom.version,
      })
    ).error,
  );
  return readRoom(waitingRoom.id);
}

async function assertRoomUnchanged(roomId, expectedRoom, label) {
  const actualRoom = await readRoom(roomId);
  assert.deepEqual(
    {
      host_id: actualRoom.host_id,
      status: actualRoom.status,
      state: actualRoom.state,
      version: actualRoom.version,
      memberCount: await readMemberCount(roomId),
    },
    {
      host_id: expectedRoom.host_id,
      status: expectedRoom.status,
      state: expectedRoom.state,
      version: expectedRoom.version,
      memberCount: expectedRoom.state.playerIds.length,
    },
    `${label} modified room state`,
  );
}

async function readProfileCounters(supabase, userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("games_played, games_won, hits_delivered, hits_received")
    .eq("id", userId)
    .single();
  assert.ifError(error);
  return data;
}

async function readObligation(supabase, obligationId) {
  const { data, error } = await supabase
    .from("hit_obligations")
    .select("*")
    .eq("id", obligationId)
    .single();
  assert.ifError(error);
  return data;
}

async function playCurrentTurn(roomId, room, actionName, raiseTo = null) {
  const turnId = room.state.betting.turnPlayerId;
  const { error } = await actorClient(turnId).rpc(
    "play_game_action",
    {
      target_room: roomId,
      expected_version: room.version,
      action_name: actionName,
      raise_to: raiseTo,
    },
  );
  assert.ifError(error);
  return readRoom(roomId);
}

async function callCurrentTurn(roomId, room) {
  return playCurrentTurn(roomId, room, "call");
}

async function playRoundToShowdown(roomId) {
  let room = await readRoom(roomId);
  let bettingActionCount = 0;
  while (room.state.phase === "betting") {
    if (bettingActionCount >= MAX_BETTING_ACTIONS) {
      assert.fail(
        `round exceeded ${MAX_BETTING_ACTIONS} betting actions`,
      );
    }
    bettingActionCount += 1;
    room = await callCurrentTurn(roomId, room);
  }
  assert.equal(room.state.phase, "showdown");
  assertPublicState(room.state);
  return room;
}

async function playTwoFoldRound(roomId, room, afterFirstRaise = null) {
  const firstRaise = (
    BigInt(room.state.betting.currentStake) + 2n
  ).toString();
  room = await playCurrentTurn(roomId, room, "raise", firstRaise);
  if (afterFirstRaise) {
    await afterFirstRaise();
  }

  const firstFoldTurn = room.state.betting.turnPlayerId;
  const firstFold = await actorClient(firstFoldTurn).rpc("play_game_action", {
    target_room: roomId,
    expected_version: room.version,
    action_name: "fold",
    raise_to: null,
  });
  assert.ifError(firstFold.error);
  room = await readRoom(roomId);
  const firstFoldStake = room.state.foldedStakes[firstFoldTurn];
  assert.equal(BigInt(firstFoldStake), BigInt(firstRaise));

  const secondRaise = (
    BigInt(room.state.betting.currentStake) + 3n
  ).toString();
  room = await playCurrentTurn(roomId, room, "raise", secondRaise);
  const secondFoldTurn = room.state.betting.turnPlayerId;
  const secondFold = await actorClient(secondFoldTurn).rpc("play_game_action", {
    target_room: roomId,
    expected_version: room.version,
    action_name: "fold",
    raise_to: null,
  });
  assert.ifError(secondFold.error);
  room = await readRoom(roomId);
  const secondFoldStake = room.state.foldedStakes[secondFoldTurn];
  assert.equal(BigInt(secondFoldStake), BigInt(secondRaise));

  room = await playRoundToShowdown(roomId);
  assert.equal(room.state.foldedPlayerIds.length, 2);
  assert.equal(room.state.phase, "showdown");
  assert.ok(
    !room.state.winnerIds.some((id) => room.state.foldedPlayerIds.includes(id)),
  );
  assert.equal(
    new Set(Object.values(room.state.foldedStakes).map(String)).size,
    2,
    "folded stakes should freeze at different current stakes",
  );
  return room;
}

async function readRoundResults(roundToken) {
  const { data, error } = await admin
    .from("game_results")
    .select("*")
    .eq("round_token", roundToken);
  assert.ifError(error);
  return trackResultRows(data);
}

let qaError = null;
try {
const provisionedHostId = await provisionQaUser(hostAccountId);
const provisionedGuestId = await provisionQaUser(guestAccountId);
const provisionedGuestTwoId = await provisionQaUser(guestTwoAccountId);
const provisionedGuestThreeId = await provisionQaUser(guestThreeAccountId);
const provisionedObserverId = await provisionQaUser(observerAccountId);
const hostId = await signIn(host, hostAccountId);
const guestId = await signIn(guest, guestAccountId);
const guestTwoId = await signIn(guestTwo, guestTwoAccountId);
const guestThreeId = await signIn(guestThree, guestThreeAccountId);
const observerId = await signIn(observer, observerAccountId);
assert.equal(hostId, provisionedHostId);
assert.equal(guestId, provisionedGuestId);
assert.equal(guestTwoId, provisionedGuestTwoId);
assert.equal(guestThreeId, provisionedGuestThreeId);
assert.equal(observerId, provisionedObserverId);
assert.equal(
  new Set([hostId, guestId, guestTwoId, guestThreeId, observerId]).size,
  5,
);
participantClients.set(hostId, host);
participantClients.set(guestId, guest);
participantClients.set(guestTwoId, guestTwo);
participantClients.set(guestThreeId, guestThree);
const fourPlayers = [
  { userId: hostId, supabase: host },
  { userId: guestId, supabase: guest },
  { userId: guestTwoId, supabase: guestTwo },
  { userId: guestThreeId, supabase: guestThree },
];
const twoPlayers = fourPlayers.slice(0, 2);

const largeOfflineHits = "900719925474099312345678901234567890";
const offlineRemainingHits = (BigInt(largeOfflineHits) - 1n).toString();
const profilesBeforeOffline = await Promise.all([
  readProfileCounters(host, hostId),
  readProfileCounters(guest, guestId),
]);
const { data: offlineRpcData, error: offlineRpcError } = await host.rpc(
  "add_offline_hit_obligation",
  {
    counterparty_id: guestId,
    direction: "i_hit",
    hits: largeOfflineHits,
  },
);
assert.ifError(offlineRpcError);
const offlineObligation = Array.isArray(offlineRpcData)
  ? offlineRpcData[0]
  : offlineRpcData;
assert.ok(offlineObligation?.id);
offlineObligationIds.push(offlineObligation.id);
trackUnique(obligationIds, offlineObligation.id);
assert.equal(offlineObligation.source, "offline");
assert.equal(offlineObligation.game_result_id, null);
assert.equal(offlineObligation.room_id, null);
assert.equal(offlineObligation.created_by, hostId);
assert.equal(offlineObligation.creditor_id, hostId);
assert.equal(offlineObligation.debtor_id, guestId);
assertExactNumericField(
  offlineRpcResponseBody,
  "initial_hits",
  largeOfflineHits,
);
assertExactNumericField(
  offlineRpcResponseBody,
  "remaining_hits",
  largeOfflineHits,
);

const hostOfflineRead = await readObligation(host, offlineObligation.id);
const guestOfflineRead = await readObligation(guest, offlineObligation.id);
const observerOfflineRead = await readObligation(observer, offlineObligation.id);
assert.equal(hostOfflineRead.id, offlineObligation.id);
assert.equal(guestOfflineRead.id, offlineObligation.id);
assert.equal(observerOfflineRead.id, offlineObligation.id);

const { data: iOweRpcData, error: iOweRpcError } = await host.rpc(
  "add_offline_hit_obligation",
  {
    counterparty_id: guestId,
    direction: "i_owe",
    hits: "3",
  },
);
assert.ifError(iOweRpcError);
const iOweObligation = Array.isArray(iOweRpcData)
  ? iOweRpcData[0]
  : iOweRpcData;
assert.ok(iOweObligation?.id);
offlineObligationIds.push(iOweObligation.id);
trackUnique(obligationIds, iOweObligation.id);
assert.equal(iOweObligation.created_by, hostId);
assert.equal(iOweObligation.debtor_id, hostId);
assert.equal(iOweObligation.creditor_id, guestId);
assert.equal(
  (await readObligation(host, iOweObligation.id)).id,
  iOweObligation.id,
);
assert.equal(
  (await readObligation(guest, iOweObligation.id)).id,
  iOweObligation.id,
);
assert.equal(
  (await readObligation(observer, iOweObligation.id)).id,
  iOweObligation.id,
);
expectError(
  await observer.rpc("record_physical_hit", {
    obligation_id: iOweObligation.id,
    expected_remaining: "3",
  }),
  "third-party hit recording",
);

const exactOfflineRead = await host
  .from("hit_obligations")
  .select("id")
  .eq("id", offlineObligation.id)
  .eq("initial_hits", largeOfflineHits)
  .eq("remaining_hits", largeOfflineHits)
  .eq("delivered_hits", 0);
assert.ifError(exactOfflineRead.error);
assert.deepEqual(exactOfflineRead.data, [{ id: offlineObligation.id }]);

const profilesAfterOffline = await Promise.all([
  readProfileCounters(host, hostId),
  readProfileCounters(guest, guestId),
]);
assert.deepEqual(profilesAfterOffline, profilesBeforeOffline);

const { data: iOweHitResult, error: iOweHitError } = await guest.rpc(
  "record_physical_hit",
  {
    obligation_id: iOweObligation.id,
    expected_remaining: "3",
  },
);
assert.ifError(iOweHitError);
assert.equal(String(iOweHitResult.remainingHits), "2");
assert.equal(BigInt(iOweHitResult.deliveredHits), 1n);

expectRejectedOfflineRpc(
  await host.rpc("add_offline_hit_obligation", {
    counterparty_id: hostId,
    direction: "i_hit",
    hits: "1",
  }),
  "self offline obligation",
);
expectRejectedOfflineRpc(
  await host.rpc("add_offline_hit_obligation", {
    counterparty_id: guestId,
    direction: "i_hit",
    hits: "01",
  }),
  "noncanonical offline hit count",
);
expectRejectedOfflineRpc(
  await host.rpc("add_offline_hit_obligation", {
    counterparty_id: guestId,
    direction: "invalid",
    hits: "1",
  }),
  "invalid offline direction",
);

const directOfflineInsert = {
  id: crypto.randomUUID(),
  game_result_id: null,
  room_id: null,
  debtor_id: guestId,
  creditor_id: hostId,
  initial_hits: "2",
  remaining_hits: "2",
  source: "offline",
  created_by: hostId,
};
offlineObligationIds.push(directOfflineInsert.id);
trackUnique(obligationIds, directOfflineInsert.id);
expectError(
  await host.from("hit_obligations").insert(directOfflineInsert),
  "direct offline ledger insertion",
);
const directOfflineUpsert = {
  ...directOfflineInsert,
  id: crypto.randomUUID(),
};
offlineObligationIds.push(directOfflineUpsert.id);
trackUnique(obligationIds, directOfflineUpsert.id);
expectError(
  await host.from("hit_obligations").upsert(directOfflineUpsert),
  "direct offline ledger upsert",
);

const { data: offlineHitResult, error: offlineHitError } = await host.rpc(
  "record_physical_hit",
  {
    obligation_id: offlineObligation.id,
    expected_remaining: largeOfflineHits,
  },
);
assert.ifError(offlineHitError);
assert.equal(offlineHitResult.remainingHits, offlineRemainingHits);
assert.equal(offlineHitResult.deliveredHits, 1);
const exactOfflineHitRead = await host
  .from("hit_obligations")
  .select("id")
  .eq("id", offlineObligation.id)
  .eq("remaining_hits", offlineRemainingHits)
  .eq("delivered_hits", 1);
assert.ifError(exactOfflineHitRead.error);
assert.deepEqual(exactOfflineHitRead.data, [{ id: offlineObligation.id }]);

const roomCreated = await createReadyRoom(fourPlayers);
const roomId = roomCreated.id;

const participantPresence = await Promise.all([
  host.rpc("touch_room_presence", { target_room: roomId }),
  guest.rpc("touch_room_presence", { target_room: roomId }),
  guestTwo.rpc("touch_room_presence", { target_room: roomId }),
  guestThree.rpc("touch_room_presence", { target_room: roomId }),
]);
for (const presence of participantPresence) assert.ifError(presence.error);

assert.ifError(
  (
    await host.rpc("start_game_round", {
      target_room: roomId,
      expected_version: roomCreated.version,
    })
  ).error,
);

let room = await readRoom(roomId);
assertPublicState(room.state);
assert.equal(room.state.phase, "betting");

const hostHandsBefore = await host
  .from("game_round_hands")
  .select("player_id, card_ids")
  .eq("room_id", roomId);
const guestHandsBefore = await guest
  .from("game_round_hands")
  .select("player_id, card_ids")
  .eq("room_id", roomId);
const guestTwoHandsBefore = await guestTwo
  .from("game_round_hands")
  .select("player_id, card_ids")
  .eq("room_id", roomId);
const guestThreeHandsBefore = await guestThree
  .from("game_round_hands")
  .select("player_id, card_ids")
  .eq("room_id", roomId);
assert.ifError(hostHandsBefore.error);
assert.ifError(guestHandsBefore.error);
assert.ifError(guestTwoHandsBefore.error);
assert.ifError(guestThreeHandsBefore.error);
assert.deepEqual(hostHandsBefore.data.map((hand) => hand.player_id), [hostId]);
assert.deepEqual(guestHandsBefore.data.map((hand) => hand.player_id), [guestId]);
assert.deepEqual(guestTwoHandsBefore.data.map((hand) => hand.player_id), [
  guestTwoId,
]);
assert.deepEqual(guestThreeHandsBefore.data.map((hand) => hand.player_id), [
  guestThreeId,
]);

const hostOpponentRead = await host
  .from("game_round_hands")
  .select("player_id, card_ids")
  .eq("room_id", roomId)
  .eq("player_id", guestId);
assert.ifError(hostOpponentRead.error);
assert.equal(hostOpponentRead.data.length, 0);

const tamperedRoom = await host
  .from("game_rooms")
  .update({ state: { tampered: true } })
  .eq("id", roomId)
  .select("id");
assert.ok(
  tamperedRoom.error || tamperedRoom.data.length === 0,
  "direct room-state mutation should be rejected or affect zero rows",
);
room = await readRoom(roomId);
assert.equal(room.version, 1);
assertPublicState(room.state);
expectError(
  await host.from("game_results").insert({
    room_id: roomId,
    winner_id: hostId,
    player_ids: [hostId, guestId, guestTwoId, guestThreeId],
    stake: "999999",
    round_token: crypto.randomUUID(),
  }),
  "direct result insertion",
);
const initialVersion = room.version;
const initialStake = room.state.betting.currentStake;
const turnId = room.state.betting.turnPlayerId;
const nonTurnId = room.state.playerIds.find((playerId) => playerId !== turnId);
assert.ok(nonTurnId);
expectError(
  await actorClient(nonTurnId).rpc("play_game_action", {
    target_room: roomId,
    expected_version: initialVersion,
    action_name: "call",
    raise_to: null,
  }),
  "out-of-turn action",
);
expectError(
  await actorClient(turnId).rpc("play_game_action", {
    target_room: roomId,
    expected_version: initialVersion,
    action_name: "raise",
    raise_to: initialStake.toString(),
  }),
  "non-increasing raise",
);

room = await playTwoFoldRound(roomId, room, async () => {
  expectError(
    await actorClient(turnId).rpc("play_game_action", {
      target_room: roomId,
      expected_version: initialVersion,
      action_name: "call",
      raise_to: null,
    }),
    "stale action replay",
  );
});

const hostHandsAfter = await host
  .from("game_round_hands")
  .select("player_id, card_ids")
  .eq("room_id", roomId)
  .eq("round_token", room.state.roundToken);
assert.ifError(hostHandsAfter.error);
assert.equal(hostHandsAfter.data.length, 4);

let resultRows = await readRoundResults(room.state.roundToken);
assert.equal(resultRows.length, 1);
let foldedRoundAttempts = 1;
while (room.state.winnerIds.length !== 1 && foldedRoundAttempts < 12) {
  foldedRoundAttempts += 1;
  await touchParticipants(roomId, fourPlayers);
  const { error: nextFoldedRoundError } = await host.rpc(
    "start_game_round",
    {
      target_room: roomId,
      expected_version: room.version,
    },
  );
  assert.ifError(nextFoldedRoundError);
  room = await playTwoFoldRound(roomId, await readRoom(roomId));
  resultRows = await readRoundResults(room.state.roundToken);
  assert.equal(resultRows.length, 1);
}
assert.equal(room.state.winnerIds.length, 1);
const { data: debtRows, error: debtError } = await admin
  .from("hit_obligations")
  .select("id, debtor_id, creditor_id, initial_hits")
  .eq("game_result_id", resultRows[0].id);
assert.ifError(debtError);
const debts = trackObligationRows(debtRows);
assert.equal(debts.length, 3);
for (const debt of debts) {
  const frozen = room.state.foldedStakes[debt.debtor_id];
  const expected = frozen ?? room.state.betting.currentStake;
  assert.equal(BigInt(debt.initial_hits), BigInt(expected));
}

const observerRoomBefore = room;
expectError(
  await observer.rpc("touch_room_presence", { target_room: roomId }),
  "observer presence touch",
);
expectError(
  await observer.rpc("close_game_room", {
    target_room: roomId,
    expected_version: room.version,
  }),
  "observer room close",
);
const observerLeaveVersion = room.version;
const firstObserverLeave = await observer.rpc("leave_game_room", {
  target_room: roomId,
  expected_version: observerLeaveVersion,
});
assert.ifError(firstObserverLeave.error);
assert.equal(firstObserverLeave.data.left, true);
const secondObserverLeave = await observer.rpc("leave_game_room", {
  target_room: roomId,
  expected_version: observerLeaveVersion,
});
assert.ifError(secondObserverLeave.error);
assert.equal(secondObserverLeave.data.left, true);
expectError(
  await observer.rpc("expire_idle_game_room", { target_room: roomId }),
  "observer room expiry",
);
await assertRoomUnchanged(roomId, observerRoomBefore, "observer lifecycle");

await touchParticipants(roomId, fourPlayers);
const staleLastSeenAt = new Date(Date.now() - PRESENCE_BACKDATE_MS).toISOString();
const { data: stalePresenceRows, error: stalePresenceError } = await admin
  .from("room_members")
  .update({ last_seen_at: staleLastSeenAt })
  .eq("room_id", roomId)
  .eq("user_id", guestThreeId)
  .select("last_seen_at");
assert.ifError(stalePresenceError);
assert.equal(stalePresenceRows.length, 1);
assert.ok(
  Date.parse(stalePresenceRows[0].last_seen_at) <
    Date.now() - PRESENCE_BACKDATE_MS,
);
expectErrorMessage(
  await host.rpc("start_game_round", {
    target_room: roomId,
    expected_version: room.version,
  }),
  /Every player must be online/i,
  "offline next round",
);
await assertRoomUnchanged(roomId, room, "offline next-round rejection");
const restoredPresence = await guestThree.rpc("touch_room_presence", {
  target_room: roomId,
});
assert.ifError(restoredPresence.error);
assert.ifError(
  (
    await host.rpc("start_game_round", {
      target_room: roomId,
      expected_version: room.version,
    })
  ).error,
);
room = await playRoundToShowdown(roomId);
resultRows = await readRoundResults(room.state.roundToken);
assert.equal(resultRows.length, 1);

let winnerId = resultRows[0].winner_id;
for (let attempt = 0; winnerId === null && attempt < 12; attempt += 1) {
  await touchParticipants(roomId, fourPlayers);
  assert.ifError(
    (
      await host.rpc("start_game_round", {
        target_room: roomId,
        expected_version: room.version,
      })
    ).error,
  );
  room = await playRoundToShowdown(roomId);
  resultRows = await readRoundResults(room.state.roundToken);
  assert.equal(resultRows.length, 1);
  winnerId = resultRows[0].winner_id;
}
assert.ok(winnerId, "expected a sole winner within 13 rounds");

const winner = actorClient(winnerId);
const { data: obligations, error: obligationsError } = await winner
  .from("hit_obligations")
  .select("*")
  .eq("game_result_id", resultRows[0].id);
assert.ifError(obligationsError);
assert.equal(obligations.length, 3);
trackObligationRows(obligations);
const obligation = obligations[0];
const loser = actorClient(obligation.debtor_id);

const tamperedObligation = await winner
  .from("hit_obligations")
  .update({ remaining_hits: 0, delivered_hits: obligation.initial_hits })
  .eq("id", obligation.id)
  .select("id");
assert.ok(
  tamperedObligation.error || tamperedObligation.data.length === 0,
  "direct ledger mutation should be rejected or affect zero rows",
);
const unchangedObligation = await winner
  .from("hit_obligations")
  .select("remaining_hits, delivered_hits")
  .eq("id", obligation.id)
  .single();
assert.ifError(unchangedObligation.error);
assert.equal(
  BigInt(unchangedObligation.data.remaining_hits),
  BigInt(obligation.remaining_hits),
);
assert.equal(
  BigInt(unchangedObligation.data.delivered_hits),
  BigInt(obligation.delivered_hits),
);
expectError(
  await loser.rpc("record_physical_hit", {
    obligation_id: obligation.id,
    expected_remaining: obligation.remaining_hits,
  }),
  "debtor hit recording",
);
assert.ifError(
  (
    await winner.rpc("record_physical_hit", {
      obligation_id: obligation.id,
      expected_remaining: obligation.remaining_hits,
    })
  ).error,
);
expectError(
  await winner.rpc("record_physical_hit", {
    obligation_id: obligation.id,
    expected_remaining: obligation.remaining_hits,
  }),
  "stale hit replay",
);

const finalObligation = await winner
  .from("hit_obligations")
  .select("remaining_hits, delivered_hits")
  .eq("id", obligation.id)
  .single();
assert.ifError(finalObligation.error);
assert.equal(
  BigInt(finalObligation.data.remaining_hits),
  BigInt(obligation.remaining_hits) - 1n,
);
assert.equal(
  BigInt(finalObligation.data.delivered_hits),
  BigInt(obligation.delivered_hits) + 1n,
);

const leaveRoom = await createActiveRoom(twoPlayers);
let leaveSettlementRoom = await playRoundToShowdown(leaveRoom.id);
let leaveSettlementResults = await readRoundResults(
  leaveSettlementRoom.state.roundToken,
);
let leaveSettlementAttempts = 1;
while (
  leaveSettlementRoom.state.winnerIds.length !== 1 &&
  leaveSettlementAttempts < 12
) {
  leaveSettlementAttempts += 1;
  await touchParticipants(leaveRoom.id, twoPlayers);
  const { error: nextLeaveRoundError } = await host.rpc("start_game_round", {
    target_room: leaveRoom.id,
    expected_version: leaveSettlementRoom.version,
  });
  assert.ifError(nextLeaveRoundError);
  leaveSettlementRoom = await playRoundToShowdown(leaveRoom.id);
  leaveSettlementResults = await readRoundResults(
    leaveSettlementRoom.state.roundToken,
  );
}
assert.equal(leaveSettlementRoom.state.winnerIds.length, 1);
assert.equal(leaveSettlementResults.length, 1);
const leaveResultIds = leaveSettlementResults.map(({ id }) => id).sort();
const { data: leaveObligations, error: leaveObligationsError } = await admin
  .from("hit_obligations")
  .select("id")
  .eq("game_result_id", leaveResultIds[0]);
assert.ifError(leaveObligationsError);
const leaveObligationIds = trackObligationRows(leaveObligations)
  .map(({ id }) => id)
  .sort();
assert.equal(leaveObligationIds.length, 1);
const leaveResult = await guest.rpc("leave_game_room", {
  target_room: leaveRoom.id,
  expected_version: leaveSettlementRoom.version,
});
assert.ifError(leaveResult.error);
assert.equal(leaveResult.data.left, true);
const closedLeaveRoom = await readRoomAsAdmin(leaveRoom.id);
const leaveMemberCount = await readMemberCount(leaveRoom.id);
assert.equal(closedLeaveRoom.status, "closed");
assert.equal(leaveMemberCount, 0);
const { data: preservedResults, error: preservedResultsError } = await admin
  .from("game_results")
  .select("id")
  .in("id", leaveResultIds);
assert.ifError(preservedResultsError);
const preservedResultIds = preservedResults.map(({ id }) => id).sort();
assert.deepEqual(preservedResultIds, leaveResultIds);
const { data: preservedObligations, error: preservedObligationsError } =
  await admin
    .from("hit_obligations")
    .select("id")
    .in("id", leaveObligationIds);
assert.ifError(preservedObligationsError);
const preservedObligationIds = preservedObligations
  .map(({ id }) => id)
  .sort();
assert.deepEqual(preservedObligationIds, leaveObligationIds);

const idleRoom = await createActiveRoom(twoPlayers);
const idleBackdate = new Date(Date.now() - IDLE_BACKDATE_MS).toISOString();
const { data: idleBackdateRows, error: idleBackdateError } = await admin
  .from("game_rooms")
  .update({ updated_at: idleBackdate })
  .eq("id", idleRoom.id)
  .select("updated_at");
assert.ifError(idleBackdateError);
assert.equal(idleBackdateRows.length, 1);
assert.ok(
  Date.parse(idleBackdateRows[0].updated_at) <
    Date.now() - IDLE_BACKDATE_MS,
);
const [hostExpiry, guestExpiry] = await Promise.all([
  host.rpc("expire_idle_game_room", { target_room: idleRoom.id }),
  guest.rpc("expire_idle_game_room", { target_room: idleRoom.id }),
]);
assert.ifError(hostExpiry.error);
assert.ifError(guestExpiry.error);
assert.equal(hostExpiry.data.expired, true);
assert.equal(guestExpiry.data.expired, true);
const closedIdleRoom = await readRoomAsAdmin(idleRoom.id);
const idleMemberCount = await readMemberCount(idleRoom.id);
assert.equal(closedIdleRoom.status, "closed");
assert.equal(idleMemberCount, 0);

console.log(
  JSON.stringify({
    opponentHandHiddenBeforeShowdown: true,
    publicStateHasNoCards: true,
    directAuthorityWritesRejected: 5,
    invalidActionsRejected: 3,
    duplicateSettlementCount: resultRows.length,
    hitReplayRejected: true,
    offlineObligationCreated: true,
    offlineVisibleToBothParties: true,
    offlineProfileCountersUnchanged: true,
    offlineInvalidInputsRejected: 3,
    offlineDirectWritesRejected: 2,
    offlinePhysicalHitRecorded: true,
    globalLedgerVisibleToObserver: true,
    iOweDirectionVerified: true,
    thirdPartyHitRejected: true,
    iOwePhysicalHitRecorded: true,
    fourParticipantActorsMapped: true,
    fourPlayerPresenceVerified: true,
    differentStakeFoldsVerified: true,
    foldedWinnerRejected: true,
    stalePresenceRejectedAndRestored: true,
    observerLifecycleDenied: true,
    activeLeaveClosedRoom: true,
    concurrentIdleExpiryVerified: true,
  }),
);
} catch (error) {
  qaError = error;
}

let cleanupError = null;
try {
  await cleanupQaData();
} catch (error) {
  cleanupError = error;
}

throwQaOrCleanupError(qaError, cleanupError);

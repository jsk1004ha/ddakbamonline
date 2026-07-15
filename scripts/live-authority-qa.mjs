import assert from "node:assert/strict";

import { createClient } from "@supabase/supabase-js";

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

function client() {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const host = client();
const guest = client();
const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const createdUserIds = [];
let qaRoomId = null;

async function provisionQaUser(accountId) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `${accountId}@${internalDomain}`,
    password: qaPassword,
    email_confirm: true,
    user_metadata: { display_name: accountId },
  });
  assert.ifError(error);
  assert.ok(data.user?.id);
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function cleanupQaData() {
  if (createdUserIds.length > 0) {
    const { data: results, error: resultsError } = await admin
      .from("game_results")
      .select("id")
      .contains("player_ids", createdUserIds);
    assert.ifError(resultsError);
    const resultIds = results.map((result) => result.id);
    if (resultIds.length > 0) {
      assert.ifError(
        (await admin.from("hit_obligations").delete().in("game_result_id", resultIds))
          .error,
      );
      assert.ifError(
        (await admin.from("game_results").delete().in("id", resultIds)).error,
      );
    }
  }

  if (qaRoomId) {
    assert.ifError(
      (await admin.from("game_rooms").delete().eq("id", qaRoomId)).error,
    );
  }

  for (const userId of createdUserIds.reverse()) {
    assert.ifError((await admin.auth.admin.deleteUser(userId)).error);
  }
}

function expectError(result, label) {
  assert.ok(result.error, `${label} should be rejected`);
}

function assertPublicState(state) {
  assert.equal(Number(state.schema), 2);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('"hands"'), "public state exposed hands");
  assert.ok(!serialized.includes('"cardIds"'), "public state exposed card IDs");
  assert.ok(!serialized.includes('"imageId"'), "public state exposed image IDs");
}

function actorClient(userId, hostId, guestId) {
  if (userId === hostId) return host;
  if (userId === guestId) return guest;
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

async function callCurrentTurn(roomId, room, hostId, guestId) {
  const turnId = room.state.betting.turnPlayerId;
  const { error } = await actorClient(turnId, hostId, guestId).rpc(
    "play_game_action",
    {
      target_room: roomId,
      expected_version: room.version,
      action_name: "call",
      raise_to: null,
    },
  );
  assert.ifError(error);
  return readRoom(roomId);
}

async function playRoundToShowdown(roomId, hostId, guestId) {
  let room = await readRoom(roomId);
  while (room.state.phase === "betting") {
    room = await callCurrentTurn(roomId, room, hostId, guestId);
  }
  assert.equal(room.state.phase, "showdown");
  assertPublicState(room.state);
  return room;
}

try {
const qaSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const hostAccountId = `qa_host_${qaSuffix}`;
const guestAccountId = `qa_guest_${qaSuffix}`;
const provisionedHostId = await provisionQaUser(hostAccountId);
const provisionedGuestId = await provisionQaUser(guestAccountId);
const hostId = await signIn(host, hostAccountId);
const guestId = await signIn(guest, guestAccountId);
assert.equal(hostId, provisionedHostId);
assert.equal(guestId, provisionedGuestId);
assert.notEqual(hostId, guestId);

const roomCode = `Q${Math.random().toString(36).slice(2, 7)}`
  .toUpperCase()
  .replace(/[01]/g, "A");
const { data: roomCreated, error: roomError } = await host
  .from("game_rooms")
  .insert({ code: roomCode, host_id: hostId, max_players: 2 })
  .select("*")
  .single();
assert.ifError(roomError);
qaRoomId = roomCreated.id;
const roomId = qaRoomId;

assert.ifError(
  (
    await host
      .from("room_members")
      .insert({ room_id: roomId, user_id: hostId, seat: 0 })
  ).error,
);
assert.ifError(
  (
    await guest
      .from("room_members")
      .insert({ room_id: roomId, user_id: guestId, seat: 1 })
  ).error,
);
assert.ifError(
  (
    await host
      .from("room_members")
      .update({ ready: true })
      .eq("room_id", roomId)
      .eq("user_id", hostId)
  ).error,
);
assert.ifError(
  (
    await guest
      .from("room_members")
      .update({ ready: true })
      .eq("room_id", roomId)
      .eq("user_id", guestId)
  ).error,
);

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
assert.ifError(hostHandsBefore.error);
assert.ifError(guestHandsBefore.error);
assert.deepEqual(hostHandsBefore.data.map((hand) => hand.player_id), [hostId]);
assert.deepEqual(guestHandsBefore.data.map((hand) => hand.player_id), [guestId]);

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
    player_ids: [hostId, guestId],
    stake: 999999,
    round_token: crypto.randomUUID(),
  }),
  "direct result insertion",
);
expectError(
  await host.from("hit_obligations").insert({
    game_result_id: crypto.randomUUID(),
    room_id: roomId,
    debtor_id: guestId,
    creditor_id: hostId,
    initial_hits: 999999,
    remaining_hits: 999999,
  }),
  "direct ledger insertion",
);

const initialVersion = room.version;
const initialStake = room.state.betting.currentStake;
const turnId = room.state.betting.turnPlayerId;
const nonTurnId = turnId === hostId ? guestId : hostId;
expectError(
  await actorClient(nonTurnId, hostId, guestId).rpc("play_game_action", {
    target_room: roomId,
    expected_version: initialVersion,
    action_name: "call",
    raise_to: null,
  }),
  "out-of-turn action",
);
expectError(
  await actorClient(turnId, hostId, guestId).rpc("play_game_action", {
    target_room: roomId,
    expected_version: initialVersion,
    action_name: "raise",
    raise_to: String(initialStake),
  }),
  "non-increasing raise",
);

room = await callCurrentTurn(roomId, room, hostId, guestId);
expectError(
  await actorClient(turnId, hostId, guestId).rpc("play_game_action", {
    target_room: roomId,
    expected_version: initialVersion,
    action_name: "call",
    raise_to: null,
  }),
  "stale action replay",
);
room = await playRoundToShowdown(roomId, hostId, guestId);

const hostHandsAfter = await host
  .from("game_round_hands")
  .select("player_id, card_ids")
  .eq("room_id", roomId)
  .eq("round_token", room.state.roundToken);
assert.ifError(hostHandsAfter.error);
assert.equal(hostHandsAfter.data.length, 2);

let { data: resultRows, error: resultError } = await host
  .from("game_results")
  .select("*")
  .eq("round_token", room.state.roundToken);
assert.ifError(resultError);
assert.equal(resultRows.length, 1);

let winnerId = resultRows[0].winner_id;
for (let attempt = 0; winnerId === null && attempt < 12; attempt += 1) {
  assert.ifError(
    (
      await host.rpc("start_game_round", {
        target_room: roomId,
        expected_version: room.version,
      })
    ).error,
  );
  room = await playRoundToShowdown(roomId, hostId, guestId);
  ({ data: resultRows, error: resultError } = await host
    .from("game_results")
    .select("*")
    .eq("round_token", room.state.roundToken));
  assert.ifError(resultError);
  assert.equal(resultRows.length, 1);
  winnerId = resultRows[0].winner_id;
}
assert.ok(winnerId, "expected a sole winner within 13 rounds");

const winner = actorClient(winnerId, hostId, guestId);
const loser = winnerId === hostId ? guest : host;
const { data: obligations, error: obligationsError } = await winner
  .from("hit_obligations")
  .select("*")
  .eq("game_result_id", resultRows[0].id);
assert.ifError(obligationsError);
assert.equal(obligations.length, 1);
const obligation = obligations[0];

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
  Number(unchangedObligation.data.remaining_hits),
  Number(obligation.remaining_hits),
);
assert.equal(
  Number(unchangedObligation.data.delivered_hits),
  Number(obligation.delivered_hits),
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
  Number(finalObligation.data.remaining_hits),
  Number(obligation.remaining_hits) - 1,
);
assert.equal(
  Number(finalObligation.data.delivered_hits),
  Number(obligation.delivered_hits) + 1,
);

console.log(
  JSON.stringify({
    opponentHandHiddenBeforeShowdown: true,
    publicStateHasNoCards: true,
    directAuthorityWritesRejected: 4,
    invalidActionsRejected: 3,
    duplicateSettlementCount: resultRows.length,
    hitReplayRejected: true,
  }),
);
} finally {
  await cleanupQaData();
}

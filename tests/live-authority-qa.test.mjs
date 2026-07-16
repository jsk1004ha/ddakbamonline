import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(
  new URL("../scripts/live-authority-qa.mjs", import.meta.url),
  "utf8",
);

test("live authority QA provisions disposable users and always cleans them up", () => {
  assert.match(script, /"SUPABASE_SERVICE_ROLE_KEY"/);
  assert.match(script, /auth\.admin\.createUser/);
  assert.match(script, /from "\.\/live-authority-cleanup\.mjs"/);
  assert.match(script, /try\s*\{/);
  assert.match(script, /catch \(error\) \{[\s\S]*qaError = error/);
  assert.match(script, /catch \(error\) \{[\s\S]*cleanupError = error/);
  assert.match(script, /throwQaOrCleanupError\(qaError, cleanupError\)/);
  assert.doesNotMatch(script, /finally\s*\{[^}]*cleanupQaData\(\)/);
  assert.match(script, /auth\.admin\.deleteUser/);
  assert.doesNotMatch(script, /"QA_HOST_ID"|"QA_GUEST_ID"/);
});

test("QA namespace identifiers are registered before creates and recover response-lost rows", () => {
  const namespaceIndex = script.indexOf("const qaNamespace");
  const emailsIndex = script.indexOf("const qaEmails");
  const roomCodesIndex = script.indexOf("const qaRoomCodes");
  const firstRemoteCreate = Math.min(
    script.indexOf("auth.admin.createUser"),
    script.indexOf('.from("game_rooms")\n    .insert'),
  );
  assert.ok(namespaceIndex >= 0);
  assert.ok(emailsIndex > namespaceIndex);
  assert.ok(roomCodesIndex > emailsIndex);
  assert.ok(roomCodesIndex < firstRemoteCreate);
  assert.match(script, /const qaEmailSet = new Set\(qaEmails\)/);
  assert.match(script, /const qaRoomCodeSet = new Set\(qaRoomCodes\)/);
  assert.match(
    script,
    /async function discoverQaNamespaceUsers\(\)[\s\S]*?auth\.admin\.listUsers\(/,
  );
  assert.match(script, /pageCount < MAX_AUTH_USER_PAGES/);
  assert.match(script, /qaEmailSet\.has\(user\.email\)/);
  assert.match(
    script,
    /async function discoverCleanupTargets\(\)[\s\S]*?discoverQaNamespaceUsers\(\)[\s\S]*?trackUnique\(createdUserIds,[\s\S]*?\.from\("game_rooms"\)[\s\S]*?\.in\("code", qaRoomCodes\)[\s\S]*?trackUnique\(createdRoomIds,/,
  );
  assert.match(
    script,
    /label: "disposable auth users"[\s\S]*?\[\.\.\.createdUserIds\]\.reverse\(\)[\s\S]*?auth\.admin\.deleteUser/,
  );
  assert.match(
    script,
    /async function assertNoQaResidue\(\)[\s\S]*?\.from\("profiles"\)[\s\S]*?\.in\("account_id", qaAccountIds\)[\s\S]*?\.from\("game_rooms"\)[\s\S]*?\.in\("code", qaRoomCodes\)[\s\S]*?discoverQaNamespaceUsers\(\)[\s\S]*?assert\.equal\(namespaceUsers\.length, 0/,
  );
});

test("every Supabase client shares an aborting fetch timeout without dropping signals", () => {
  assert.match(script, /const REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(script, /async function fetchWithTimeout\(input, init = \{\}\)/);
  assert.match(
    script,
    /const upstreamSignal =\s*init\.signal \?\?\s*\(input instanceof Request \? input\.signal : null\)/,
  );
  assert.match(script, /const abortController = new AbortController\(\)/);
  assert.match(script, /upstreamSignal\?\.addEventListener\("abort", forwardAbort, \{ once: true \}\)/);
  assert.match(script, /setTimeout\([\s\S]*?abortController\.abort\([\s\S]*?REQUEST_TIMEOUT_MS/);
  assert.match(
    script,
    /fetch\(input, \{ \.\.\.init, signal: abortController\.signal \}\)/,
  );
  assert.match(script, /finally \{[\s\S]*?clearTimeout\(timeoutId\)[\s\S]*?removeEventListener\("abort", forwardAbort\)/);
  assert.match(
    script,
    /async function fetchWithOfflineCapture[\s\S]*?fetchWithTimeout\(input, init\)/,
  );
  assert.match(
    script,
    /fetch: captureOfflineRpc \? fetchWithOfflineCapture : fetchWithTimeout/,
  );
  assert.match(
    script,
    /const admin = createClient\([\s\S]*?global: \{ fetch: fetchWithTimeout \}/,
  );
});

test("showdown driving and namespace pagination fail explicitly at finite caps", () => {
  assert.match(script, /const MAX_BETTING_ACTIONS = 16/);
  assert.match(script, /const MAX_AUTH_USER_PAGES = 100/);
  const showdown = script.match(
    /async function playRoundToShowdown\(roomId\)\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(showdown, "expected playRoundToShowdown body");
  assert.match(showdown, /let bettingActionCount = 0/);
  assert.match(
    showdown,
    /if \(bettingActionCount >= MAX_BETTING_ACTIONS\) \{[\s\S]*?assert\.fail\(/,
  );
  assert.match(showdown, /bettingActionCount \+= 1/);
  assert.match(
    script,
    /assert\.fail\(`QA Auth namespace exceeds \$\{MAX_AUTH_USER_PAGES\} pages`\)/,
  );
});

test("live authority QA provisions four participant clients and maps every actor", () => {
  assert.match(script, /const guestTwo = client\(\)/);
  assert.match(script, /const guestThree = client\(\)/);
  assert.match(script, /const guestTwoAccountId = `qa_guest_two_\$\{qaSuffix\}`/);
  assert.match(script, /const guestThreeAccountId = `qa_guest_three_\$\{qaSuffix\}`/);
  assert.match(script, /provisionQaUser\(guestTwoAccountId\)/);
  assert.match(script, /provisionQaUser\(guestThreeAccountId\)/);
  assert.match(script, /signIn\(guestTwo, guestTwoAccountId\)/);
  assert.match(script, /signIn\(guestThree, guestThreeAccountId\)/);
  assert.match(script, /participantClients\.set\(hostId, host\)/);
  assert.match(script, /participantClients\.set\(guestId, guest\)/);
  assert.match(script, /participantClients\.set\(guestTwoId, guestTwo\)/);
  assert.match(script, /participantClients\.set\(guestThreeId, guestThree\)/);
  assert.match(script, /function actorClient\(userId\)/);
});

test("four-player live QA covers presence, legal folds, showdown, and exact debts", () => {
  for (const clientName of ["host", "guest", "guestTwo", "guestThree"]) {
    assert.match(
      script,
      new RegExp(`${clientName}\\.rpc\\(\\s*"touch_room_presence"`),
      `${clientName} must touch presence`,
    );
  }

  assert.ok(
    [...script.matchAll(/action_name:\s*"fold"/g)].length >= 2,
    "two legal turns must fold",
  );
  assert.match(script, /assert\.equal\(room\.state\.foldedPlayerIds\.length,\s*2\)/);
  assert.match(script, /assert\.equal\(room\.state\.phase,\s*"showdown"\)/);
  assert.match(
    script,
    /!room\.state\.winnerIds\.some\(\(id\)\s*=>\s*room\.state\.foldedPlayerIds\.includes\(id\)\)/,
  );
  assert.match(script, /const frozen = room\.state\.foldedStakes\[debt\.debtor_id\]/);
  assert.match(script, /const expected = frozen \?\? room\.state\.betting\.currentStake/);
  assert.match(
    script,
    /assert\.equal\(BigInt\(debt\.initial_hits\),\s*BigInt\(expected\)\)/,
  );
  assert.match(
    script,
    /const secondFoldStake = room\.state\.foldedStakes\[secondFoldTurn\]/,
  );
  assert.match(
    script,
    /assert\.equal\(BigInt\(secondFoldStake\),\s*BigInt\(secondRaise\)\)/,
  );
  assert.match(
    script,
    /while \(room\.state\.winnerIds\.length !== 1[\s\S]*?playTwoFoldRound/,
    "ties must retry the same two-fold scenario",
  );
  assert.match(
    script,
    /assert\.equal\(room\.state\.winnerIds\.length,\s*1[\s\S]*?const \{ data: debtRows/,
    "exact debt assertions require a proven sole winner",
  );
  assert.doesNotMatch(
    script,
    /if \(room\.state\.winnerIds\.length === 1\)/,
    "a tie must not skip exact folded-debt proof",
  );
  assert.doesNotMatch(script, /Number\([^\n]*(?:currentStake|initial_hits|foldedStakes)/);
});

test("live QA rejects an offline next round and restores it after presence", () => {
  assert.match(script, /\.update\(\{\s*last_seen_at:/);
  assert.match(script, /Every player must be online/i);
  assert.match(script, /expectErrorMessage\([\s\S]*?start_game_round[\s\S]*?Every player must be online/);
  assert.match(
    script,
    /guestThree\.rpc\(\s*"touch_room_presence",\s*\{\s*target_room:\s*roomId\s*\}/,
  );
  assert.match(
    script,
    /guestThree\.rpc\([\s\S]*?touch_room_presence[\s\S]*?host\.rpc\([\s\S]*?start_game_round/,
  );
  assert.match(
    script,
    /await touchParticipants\(roomId, fourPlayers\);\s*const staleLastSeenAt/,
    "all four participants must be fresh immediately before one is backdated",
  );
  assert.match(script, /const PRESENCE_BACKDATE_MS = 2 \* 60_000/);
  assert.match(
    script,
    /const staleLastSeenAt = new Date\(Date\.now\(\) - PRESENCE_BACKDATE_MS\)/,
  );
  assert.match(
    script,
    /Date\.parse\(stalePresenceRows\[0\]\.last_seen_at\) <\s*Date\.now\(\) - PRESENCE_BACKDATE_MS/,
  );
});

test("authenticated observer cannot mutate another room lifecycle", () => {
  for (const rpcName of [
    "touch_room_presence",
    "close_game_room",
    "leave_game_room",
    "expire_idle_game_room",
  ]) {
    assert.match(
      script,
      new RegExp(`observer\\.rpc\\(\\s*"${rpcName}"`),
      `observer must exercise ${rpcName}`,
    );
  }
  assert.match(script, /assertRoomUnchanged\([\s\S]*?observer lifecycle/);
  const observerLeaves = [
    ...script.matchAll(/observer\.rpc\(\s*"leave_game_room"/g),
  ];
  assert.equal(observerLeaves.length, 2, "observer leave must be idempotent twice");
  assert.match(script, /const observerLeaveVersion = room\.version/);
  assert.match(
    script,
    /const firstObserverLeave =[\s\S]*?expected_version:\s*observerLeaveVersion[\s\S]*?const secondObserverLeave =[\s\S]*?expected_version:\s*observerLeaveVersion/,
  );
  assert.match(script, /assert\.equal\(firstObserverLeave\.data\.left,\s*true\)/);
  assert.match(script, /assert\.equal\(secondObserverLeave\.data\.left,\s*true\)/);
  assert.match(script, /observerLifecycleDenied:\s*true/);
});

test("separate active rooms prove leave closure and concurrent idle expiry", () => {
  assert.match(script, /const leaveRoom = await createActiveRoom\(/);
  assert.match(script, /let leaveSettlementRoom = await playRoundToShowdown\(leaveRoom\.id\)/);
  assert.match(script, /const leaveResultIds =/);
  assert.match(script, /const leaveObligationIds =/);
  assert.match(
    script,
    /guest\.rpc\(\s*"leave_game_room",\s*\{[\s\S]*?target_room:\s*leaveRoom\.id/,
  );
  assert.match(script, /assert\.equal\(closedLeaveRoom\.status,\s*"closed"\)/);
  assert.match(script, /assert\.equal\(leaveMemberCount,\s*0\)/);
  assert.match(
    script,
    /\.from\("game_results"\)[\s\S]*?\.in\("id",\s*leaveResultIds\)[\s\S]*?assert\.deepEqual\(preservedResultIds,\s*leaveResultIds\)/,
  );
  assert.match(
    script,
    /\.from\("hit_obligations"\)[\s\S]*?\.in\("id",\s*leaveObligationIds\)[\s\S]*?assert\.deepEqual\(preservedObligationIds,\s*leaveObligationIds\)/,
  );
  assert.match(script, /const idleRoom = await createActiveRoom\(/);
  assert.match(script, /\.update\(\{\s*updated_at:/);
  assert.match(
    script,
    /Promise\.all\(\[[\s\S]*?host\.rpc\(\s*"expire_idle_game_room"[\s\S]*?guest\.rpc\(\s*"expire_idle_game_room"/,
  );
  assert.match(script, /assert\.equal\(hostExpiry\.data\.expired,\s*true\)/);
  assert.match(script, /assert\.equal\(guestExpiry\.data\.expired,\s*true\)/);
  assert.match(script, /assert\.equal\(closedIdleRoom\.status,\s*"closed"\)/);
  assert.match(script, /assert\.equal\(idleMemberCount,\s*0\)/);
  assert.doesNotMatch(script, /serverIdleCleanupObserved/);
  assert.match(script, /const IDLE_BACKDATE_MS = 5 \* 60_000/);
  assert.match(
    script,
    /const idleBackdate = new Date\(Date\.now\(\) - IDLE_BACKDATE_MS\)/,
  );
  assert.match(
    script,
    /Date\.parse\(idleBackdateRows\[0\]\.updated_at\) <\s*Date\.now\(\) - IDLE_BACKDATE_MS/,
  );
});

test("cleanup tracks every generated entity, preserves dependency order, and proves zero residue", () => {
  assert.match(script, /const createdRoomIds = \[\]/);
  assert.match(script, /const resultIds = \[\]/);
  assert.match(script, /const obligationIds = \[\]/);
  assert.match(script, /createdRoomIds\.push\(/);
  assert.match(script, /resultIds\.push\(/);
  assert.match(script, /obligationIds\.push\(/);

  const cleanup = script.match(
    /async function cleanupQaData\(\)\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(cleanup, "expected cleanupQaData body");
  const obligationDelete = cleanup.indexOf('.from("hit_obligations")');
  const resultDelete = cleanup.indexOf('.from("game_results").delete()');
  const roomDelete = cleanup.indexOf('.from("game_rooms").delete()');
  const userDelete = cleanup.indexOf("auth.admin.deleteUser");
  assert.ok(obligationDelete >= 0, "obligations must be cleaned");
  assert.ok(obligationDelete < resultDelete, "obligations must precede results");
  assert.ok(resultDelete < roomDelete, "results must precede rooms");
  assert.ok(roomDelete < userDelete, "rooms must precede auth users");
  assert.match(cleanup, /assertNoQaResidue\(\)/);

  assert.match(script, /async function assertNoQaResidue\(\)/);
  assert.match(script, /\.from\("profiles"\)[\s\S]*?\.in\("account_id",\s*qaAccountIds\)/);
  assert.match(script, /auth\.admin\.getUserById/);
  assert.match(script, /assert\.equal\(lookup\.error\.name,\s*"AuthApiError"\)/);
  assert.match(script, /assert\.equal\(lookup\.error\.status,\s*404\)/);
  assert.match(script, /assert\.equal\(lookup\.error\.code,\s*"user_not_found"\)/);
  assert.match(script, /assert\.equal\(lookup\.data\.user,\s*null\)/);
  assert.doesNotMatch(script, /lookup\.error \|\| !lookup\.data\.user/);
  assert.match(script, /\.from\("game_rooms"\)[\s\S]*?\.in\("id",\s*createdRoomIds\)/);
  assert.match(script, /\.from\("game_results"\)[\s\S]*?\.in\("id",\s*resultIds\)/);
  assert.match(script, /\.from\("hit_obligations"\)[\s\S]*?\.in\("id",\s*obligationIds\)/);
  assert.match(script, /assert\.equal\([^\n]*\.length,\s*0/);
});

test("live authority QA creates an exact offline obligation with actor provenance", () => {
  assert.match(
    script,
    /const largeOfflineHits = "[1-9][0-9]{19,}"/,
    "the live check must exercise a canonical value beyond safe JS integers",
  );
  assert.match(
    script,
    /host\.rpc\(\s*"add_offline_hit_obligation",\s*\{[\s\S]*?counterparty_id:\s*guestId,[\s\S]*?direction:\s*"i_hit",[\s\S]*?hits:\s*largeOfflineHits,[\s\S]*?\}\s*\)/,
  );
  assert.match(
    script,
    /includes\("\/rpc\/add_offline_hit_obligation"\)[\s\S]*response\.clone\(\)\.text\(\)/,
  );
  assert.match(script, /offlineObligationIds\.push\(offlineObligation\.id\)/);
  assert.match(script, /assert\.equal\(offlineObligation\.source,\s*"offline"\)/);
  assert.match(script, /assert\.equal\(offlineObligation\.game_result_id,\s*null\)/);
  assert.match(script, /assert\.equal\(offlineObligation\.room_id,\s*null\)/);
  assert.match(script, /assert\.equal\(offlineObligation\.created_by,\s*hostId\)/);
  assert.match(script, /assert\.equal\(offlineObligation\.creditor_id,\s*hostId\)/);
  assert.match(script, /assert\.equal\(offlineObligation\.debtor_id,\s*guestId\)/);
  assert.match(
    script,
    /assertExactNumericField\(\s*offlineRpcResponseBody,\s*"initial_hits",\s*largeOfflineHits,?\s*\)/,
  );
  assert.match(
    script,
    /assertExactNumericField\(\s*offlineRpcResponseBody,\s*"remaining_hits",\s*largeOfflineHits,?\s*\)/,
  );
});

test("both offline parties see the row without changing profile counters", () => {
  assert.match(
    script,
    /\.select\("games_played, games_won, hits_delivered, hits_received"\)/,
  );
  assert.match(
    script,
    /profilesBeforeOffline[\s\S]*readProfileCounters\(host,\s*hostId\)[\s\S]*readProfileCounters\(guest,\s*guestId\)/,
  );
  assert.match(
    script,
    /profilesAfterOffline[\s\S]*assert\.deepEqual\(profilesAfterOffline,\s*profilesBeforeOffline\)/,
  );
  assert.match(script, /readObligation\(host,\s*offlineObligation\.id\)/);
  assert.match(script, /readObligation\(guest,\s*offlineObligation\.id\)/);
  assert.match(script, /assert\.equal\(hostOfflineRead\.id,\s*offlineObligation\.id\)/);
  assert.match(script, /assert\.equal\(guestOfflineRead\.id,\s*offlineObligation\.id\)/);
});

test("live QA covers global reads and i_owe authority", () => {
  assert.match(script, /const observer = client\(\)/);
  assert.match(script, /direction:\s*"i_owe"/);
  assert.match(script, /readObligation\(observer,\s*iOweObligation\.id\)/);
  assert.match(
    script,
    /observer\.rpc\(\s*"record_physical_hit"/,
  );
  assert.match(script, /globalLedgerVisibleToObserver:\s*true/);
  assert.match(script, /iOweDirectionVerified:\s*true/);
  assert.match(script, /thirdPartyHitRejected:\s*true/);
});

test("offline negative cases preserve the RPC-only insertion boundary", () => {
  assert.match(
    script,
    /counterparty_id:\s*hostId,[\s\S]*?direction:\s*"i_hit",[\s\S]*?hits:\s*"1"/,
  );
  assert.match(
    script,
    /counterparty_id:\s*guestId,[\s\S]*?direction:\s*"i_hit",[\s\S]*?hits:\s*"01"/,
  );
  assert.match(
    script,
    /counterparty_id:\s*guestId,[\s\S]*?direction:\s*"invalid",[\s\S]*?hits:\s*"1"/,
  );
  assert.match(script, /expectRejectedOfflineRpc[\s\S]*offlineObligationIds\.push/);
  assert.match(
    script,
    /host\.from\("hit_obligations"\)\.insert\(directOfflineInsert\)/,
  );
  assert.match(
    script,
    /host\.from\("hit_obligations"\)\.upsert\(directOfflineUpsert\)/,
  );
  assert.match(
    script,
    /const directOfflineInsert = \{[\s\S]*?game_result_id:\s*null,[\s\S]*?room_id:\s*null,[\s\S]*?source:\s*"offline",[\s\S]*?created_by:\s*hostId,[\s\S]*?\};/,
  );
  assert.match(script, /offlineObligationIds\.push\(directOfflineInsert\.id\)/);
  assert.match(script, /offlineObligationIds\.push\(directOfflineUpsert\.id\)/);
});

test("record_physical_hit consumes the offline obligation exactly", () => {
  assert.match(
    script,
    /host\.rpc\(\s*"record_physical_hit",\s*\{[\s\S]*?obligation_id:\s*offlineObligation\.id,[\s\S]*?expected_remaining:\s*largeOfflineHits/,
  );
  assert.match(
    script,
    /assert\.equal\(offlineHitResult\.remainingHits,\s*offlineRemainingHits\)/,
  );
  assert.match(script, /assert\.equal\(offlineHitResult\.deliveredHits,\s*1\)/);
  assert.match(
    script,
    /\.eq\("remaining_hits",\s*offlineRemainingHits\)[\s\S]*?\.eq\("delivered_hits",\s*1\)/,
  );
});

test("offline IDs are deleted first and the summary exposes only safe checks", () => {
  assert.match(script, /const offlineObligationIds = \[\]/);
  assert.match(
    script,
    /admin\s*\.from\("hit_obligations"\)\s*\.delete\(\)\s*\.in\("id",\s*offlineObligationIds\)/,
  );

  const cleanup = script.match(
    /async function cleanupQaData\(\)\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(cleanup, "expected cleanupQaData body");
  const offlineDelete = cleanup.indexOf('in("id", offlineObligationIds)');
  const resultDelete = cleanup.indexOf('.from("game_results").delete()');
  const roomDelete = cleanup.indexOf('.from("game_rooms").delete()');
  const userDelete = cleanup.indexOf("auth.admin.deleteUser");
  assert.ok(offlineDelete >= 0, "offline obligations must be deleted explicitly");
  assert.ok(offlineDelete < resultDelete, "offline rows must precede game results");
  assert.ok(offlineDelete < roomDelete, "offline rows must precede rooms");
  assert.ok(offlineDelete < userDelete, "offline rows must precede profile/user cleanup");
  assert.match(cleanup, /runCleanupSteps\(cleanupSteps\)/);
  assert.match(
    cleanup,
    /label: "disposable auth users"[\s\S]*?\[\.\.\.createdUserIds\]\.reverse\(\)[\s\S]*?auth\.admin\.deleteUser/,
  );
  const cleanupLabels = [...cleanup.matchAll(/label:\s*[`"]([^`"]+)[`"]?/g)].map(
    (match) => match[1],
  );
  assert.ok(cleanupLabels.length >= 6, "expected safe labels for cleanup steps");
  assert.doesNotMatch(cleanupLabels.join(" "), /password|secret|token|key|\b(?:user|room|obligation)Id\b/i);

  const summary = script.match(
    /console\.log\(\s*JSON\.stringify\(\{([\s\S]*?)\}\)\s*,?\s*\);/,
  )?.[1];
  assert.ok(summary, "expected JSON QA summary");
  assert.match(summary, /directAuthorityWritesRejected:\s*5/);
  assert.match(summary, /offlineObligationCreated:\s*true/);
  assert.match(summary, /offlineVisibleToBothParties:\s*true/);
  assert.match(summary, /offlineProfileCountersUnchanged:\s*true/);
  assert.match(summary, /offlineInvalidInputsRejected:\s*3/);
  assert.match(summary, /offlineDirectWritesRejected:\s*2/);
  assert.match(summary, /offlinePhysicalHitRecorded:\s*true/);
  assert.match(summary, /globalLedgerVisibleToObserver:\s*true/);
  assert.match(summary, /iOweDirectionVerified:\s*true/);
  assert.match(summary, /thirdPartyHitRejected:\s*true/);
  assert.doesNotMatch(
    summary,
    /password|secret|token|key|accountId|userId|roomId|obligationId/i,
  );
});

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
  assert.doesNotMatch(script, /finally\s*\{[\s\S]*cleanupQaData\(\)/);
  assert.match(script, /auth\.admin\.deleteUser/);
  assert.doesNotMatch(script, /"QA_HOST_ID"|"QA_GUEST_ID"/);
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
    /\[\.\.\.createdUserIds\]\.reverse\(\)[\s\S]*cleanupSteps\.push[\s\S]*auth\.admin\.deleteUser/,
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
  assert.doesNotMatch(
    summary,
    /password|secret|token|key|accountId|userId|roomId|obligationId/i,
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const script = await readFile(
  new URL("../scripts/live-authority-qa.mjs", import.meta.url),
  "utf8",
);
const accountIdSource = await readFile(
  new URL("../src/lib/auth/account-id.ts", import.meta.url),
  "utf8",
);
const accountIdModule = ts.transpileModule(accountIdSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { accountIdEmail, validateAccountId } = await import(
  `data:text/javascript;base64,${Buffer.from(accountIdModule).toString("base64")}`
);
const handleNewUserSql = await readFile(
  new URL(
    "../supabase/migrations/20260715133733_normalize_korean_auth_hash_case.sql",
    import.meta.url,
  ),
  "utf8",
);

const importEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  QA_PASSWORD: "test-password",
};
for (const [name, value] of Object.entries(importEnv)) {
  process.env[name] ??= value;
}

const {
  createFetchWithTimeout,
  createQaIdentities,
  discoverQaNamespaceUsers,
  provisionQaUser,
  signIn,
} = await import("../scripts/live-authority-qa.mjs");

test("live QA exposes testable helpers without running the remote scenario on import", () => {
  assert.match(script, /export function createQaIdentities/);
  assert.match(script, /export function createFetchWithTimeout/);
  assert.match(script, /export async function discoverQaNamespaceUsers/);
  assert.match(script, /export async function provisionQaUser/);
  assert.match(script, /export async function signIn/);
  assert.match(script, /async function runLiveAuthorityQa\(\)/);
  assert.match(
    script,
    /if \(isDirectExecution\) \{\s*await runLiveAuthorityQa\(\);\s*\}/,
  );
});

test("QA provisioning and sign-in share trigger-compatible identity emails", async () => {
  const namespace = "0123456789abcdef0123456789abcdef";
  const identities = createQaIdentities(namespace);
  const emailByAccountId = new Map(
    identities.map(({ accountId, email }) => [accountId, email]),
  );
  const createdPayloads = [];
  const signInPayloads = [];
  const trackedUserIds = [];
  const identity = identities[0];

  await provisionQaUser(identity.accountId, {
    adminClient: {
      auth: {
        admin: {
          async createUser(payload) {
            createdPayloads.push(payload);
            return { data: { user: { id: "created-user" } }, error: null };
          },
        },
      },
    },
    emailByAccountId,
    namespace,
    password: "test-password",
    trackedUserIds,
  });
  await signIn(
    {
      auth: {
        async signInWithPassword(payload) {
          signInPayloads.push(payload);
          return { data: { user: { id: "signed-in-user" } }, error: null };
        },
      },
    },
    identity.accountId,
    { emailByAccountId, password: "test-password" },
  );

  assert.equal(createdPayloads[0].email, signInPayloads[0].email);
  assert.equal(createdPayloads[0].email, identity.email);
  assert.equal(createdPayloads[0].user_metadata.qa_namespace, namespace);
  assert.deepEqual(trackedUserIds, ["created-user"]);
  assert.equal(identities.length, 5);
  assert.equal(new Set(identities.map(({ accountId }) => accountId)).size, 5);
  for (const { accountId, email } of identities) {
    assert.equal(validateAccountId(accountId), true);
    assert.ok(accountId.length <= 20);
    assert.ok(accountId.includes(namespace.slice(0, 12)));
    assert.equal(email, await accountIdEmail(accountId));
    assert.equal(email.split("@", 1)[0], accountId);
  }
  assert.match(
    handleNewUserSql,
    /requested_account_id ~ '\^\[a-z0-9_\]\+\$'[\s\S]*?email_local_part = requested_account_id/,
  );
});

test("namespace discovery increments pages locally and stops from returned users and total", async () => {
  const namespace = "0123456789abcdef0123456789abcdef";
  const firstEmail = "qh_0123456789ab@accounts.ddakbamonline.com";
  const secondEmail = "qw_0123456789ab@accounts.ddakbamonline.com";
  const pages = [
    [
      { id: "other", email: "other@example.com", user_metadata: {} },
      {
        id: "first",
        email: firstEmail,
        user_metadata: { qa_namespace: namespace },
      },
    ],
    [
      {
        id: "second",
        email: secondEmail,
        user_metadata: { qa_namespace: namespace },
      },
    ],
  ];
  const calls = [];
  const authAdmin = {
    async listUsers(options) {
      calls.push(options);
      return {
        data: {
          users: pages[options.page - 1] ?? [],
          total: 3,
          nextPage: 999,
        },
        error: null,
      };
    },
  };

  const users = await discoverQaNamespaceUsers({
    authAdmin,
    expectedEmails: new Set([firstEmail, secondEmail]),
    namespace,
    perPage: 2,
    maxPages: 4,
  });

  assert.deepEqual(calls, [
    { page: 1, perPage: 2 },
    { page: 2, perPage: 2 },
  ]);
  assert.deepEqual(
    users.map(({ id }) => id),
    ["first", "second"],
  );
});

test("namespace discovery rejects an expected email without the exact marker", async () => {
  const namespace = "0123456789abcdef0123456789abcdef";
  const expectedEmail = "qh_0123456789ab@accounts.ddakbamonline.com";
  const authAdmin = {
    async listUsers() {
      return {
        data: {
          users: [
            {
              id: "unrelated-user",
              email: expectedEmail,
              user_metadata: { qa_namespace: "different-namespace" },
            },
          ],
          total: 1,
        },
        error: null,
      };
    },
  };
  const claimedUserIds = [];
  const deletedUserIds = [];

  await assert.rejects(
    async () => {
      const users = await discoverQaNamespaceUsers({
        authAdmin,
        expectedEmails: new Set([expectedEmail]),
        namespace,
        perPage: 10,
        maxPages: 2,
      });
      claimedUserIds.push(...users.map(({ id }) => id));
      deletedUserIds.push(...claimedUserIds);
    },
    /expected QA email is missing its exact namespace marker/,
  );
  assert.deepEqual(claimedUserIds, []);
  assert.deepEqual(deletedUserIds, []);
});

test("request deadline covers a hanging response body and releases the caller", async () => {
  const hangingBody = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  });
  const fetchWithTimeout = createFetchWithTimeout({
    timeoutMs: 20,
    fetchImpl: async () => new Response(hangingBody),
  });
  let cleanupReached = false;
  let safetyTimeoutId;
  const safetyTimeout = new Promise((_, reject) => {
    safetyTimeoutId = setTimeout(
      () => reject(new Error("test safety timeout expired")),
      250,
    );
  });

  try {
    await assert.rejects(
      Promise.race([
        (async () => {
          try {
            const response = await fetchWithTimeout("https://example.test");
            await response.text();
          } finally {
            cleanupReached = true;
          }
        })(),
        safetyTimeout,
      ]),
      { name: "AbortError" },
    );
  } finally {
    clearTimeout(safetyTimeoutId);
  }
  assert.equal(cleanupReached, true);
});

test("buffered request response preserves HTTP metadata and reusable body semantics", async () => {
  const upstream = new Response("buffered", {
    status: 201,
    statusText: "Created",
    headers: { "x-qa": "buffered" },
  });
  Object.defineProperty(upstream, "url", {
    value: "https://example.test/rest/v1/rooms",
  });
  const fetchWithTimeout = createFetchWithTimeout({
    timeoutMs: 100,
    fetchImpl: async () => upstream,
  });

  const response = await fetchWithTimeout("https://example.test");

  assert.notEqual(response, upstream);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("x-qa"), "buffered");
  assert.equal(response.url, "https://example.test/rest/v1/rooms");
  assert.equal(await response.clone().text(), "buffered");
  assert.equal(await response.text(), "buffered");
});

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
  assert.match(
    script,
    /email: `\$\{accountId\}@\$\{domain\}`/,
  );
  assert.match(script, /const entropy = namespace\.slice\(0, 12\)/);
  assert.match(script, /assert\.match\(accountId, \/\^\[a-z0-9_\]\{2,20\}\$\//);
  assert.match(script, /const qaEmailSet = new Set\(qaEmails\)/);
  assert.match(script, /const qaRoomCodeSet = new Set\(qaRoomCodes\)/);
  assert.equal(
    [...script.matchAll(/const email = emailByAccountId\.get\(accountId\)/g)]
      .length,
    2,
  );
  assert.match(
    script,
    /export async function discoverQaNamespaceUsers\(\{[\s\S]*?authAdmin\.listUsers\(/,
  );
  assert.match(script, /for \(let page = 1; page <= maxPages; page \+= 1\)/);
  assert.match(script, /users\.length < perPage/);
  assert.match(script, /page \* perPage >= total/);
  assert.doesNotMatch(script, /data\.nextPage/);
  assert.match(script, /expectedEmailSet\.has\(user\.email\)/);
  assert.match(
    script,
    /user\.user_metadata\?\.qa_namespace,[\s\S]*?namespace,[\s\S]*?"expected QA email is missing its exact namespace marker"/,
  );
  assert.match(
    script,
    /user_metadata:\s*\{[\s\S]*?qa_namespace: namespace/,
  );
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
  assert.match(script, /export function createFetchWithTimeout/);
  assert.match(script, /async function fetchWithTimeout\(input, init = \{\}\)/);
  assert.match(
    script,
    /const upstreamSignal =\s*init\.signal \?\?\s*\(input instanceof Request \? input\.signal : null\)/,
  );
  assert.match(script, /const abortController = new AbortController\(\)/);
  assert.match(script, /upstreamSignal\?\.addEventListener\("abort", forwardAbort, \{ once: true \}\)/);
  assert.match(
    script,
    /setTimeout\([\s\S]*?abortController\.abort\([\s\S]*?timeoutMs/,
  );
  assert.match(
    script,
    /fetchImpl\(input, \{[\s\S]*?\.\.\.init,[\s\S]*?signal: abortController\.signal/,
  );
  assert.match(
    script,
    /Promise\.race\(\[response\.arrayBuffer\(\), aborted\]\)/,
  );
  assert.match(
    script,
    /new Response\(body, \{[\s\S]*?status: response\.status,[\s\S]*?statusText: response\.statusText,[\s\S]*?headers: response\.headers/,
  );
  assert.match(script, /Object\.defineProperty\(bufferedResponse, "url"/);
  assert.match(script, /finally \{[\s\S]*?clearTimeout\(timeoutId\)[\s\S]*?removeEventListener\("abort", forwardAbort\)/);
  assert.match(
    script,
    /async function fetchWithOfflineCapture[\s\S]*?fetchWithTimeout\(input, init\)[\s\S]*?response\.clone\(\)\.text\(\)/,
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
    /assert\.fail\(`QA Auth namespace exceeds \$\{maxPages\} pages`\)/,
  );
});

test("live authority QA provisions four participant clients and maps every actor", () => {
  assert.match(script, /const guestTwo = client\(\)/);
  assert.match(script, /const guestThree = client\(\)/);
  assert.match(script, /const guestTwoAccountId = guestTwoIdentity\.accountId/);
  assert.match(script, /const guestThreeAccountId = guestThreeIdentity\.accountId/);
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

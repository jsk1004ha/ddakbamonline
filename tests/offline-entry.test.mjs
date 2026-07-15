import assert from "node:assert/strict";
import test from "node:test";

import * as offlineEntry from "../src/lib/ledger/offline-entry.mjs";

const {
  filterObligationsByName,
  mapOfflineParties,
  mergeObligationById,
  normalizeDisplayName,
  normalizeOfflineHits,
} = offlineEntry;

const obligations = [
  { id: "old", creditor_id: "creditor", debtor_id: "debtor" },
  {
    id: "other",
    creditor_id: "other-creditor",
    debtor_id: "other-debtor",
  },
];
const obligationNames = {
  creditor: "민수",
  debtor: "영희",
  "other-creditor": "지수",
  "other-debtor": "철수",
};

test("filters global obligations by either display name", () => {
  assert.deepEqual(
    filterObligationsByName(obligations, obligationNames, " 민 "),
    [obligations[0]],
  );
  assert.deepEqual(
    filterObligationsByName(obligations, obligationNames, "영희"),
    [obligations[0]],
  );
  assert.deepEqual(
    filterObligationsByName(obligations, obligationNames, ""),
    obligations,
  );
  assert.deepEqual(
    filterObligationsByName(obligations, obligationNames, "없음"),
    [],
  );
});

test("merges an RPC obligation by id at the front", () => {
  const replacement = { ...obligations[0], remaining_hits: "3" };
  assert.deepEqual(mergeObligationById(obligations, replacement), [
    replacement,
    obligations[1],
  ]);

  const created = {
    id: "new",
    creditor_id: "creditor",
    debtor_id: "debtor",
  };
  assert.deepEqual(mergeObligationById(obligations, created), [
    created,
    ...obligations,
  ]);
});

test("normalizeDisplayName trims a valid name", () => {
  assert.equal(normalizeDisplayName("  선우  "), "선우");
});

test("normalizeDisplayName rejects names shorter than two characters", () => {
  assert.throws(
    () => normalizeDisplayName(" 가 "),
    new Error("이름은 2~24자로 입력해 주세요."),
  );
});

test("normalizeDisplayName rejects names longer than twenty-four characters", () => {
  assert.throws(
    () => normalizeDisplayName("가".repeat(25)),
    new Error("이름은 2~24자로 입력해 주세요."),
  );
});

for (const [label, invalidName] of [
  ["null", null],
  ["undefined", undefined],
  ["an array", ["선우"]],
  ["an object", {}],
]) {
  test(`normalizeDisplayName rejects ${label} before coercion`, () => {
    assert.throws(
      () => normalizeDisplayName(invalidName),
      new Error("이름은 2~24자로 입력해 주세요."),
    );
  });
}

test("normalizeOfflineHits preserves an arbitrarily large positive integer", () => {
  const hugeHits = "1234567890123456789012345678901234567890";

  assert.equal(normalizeOfflineHits(hugeHits), hugeHits);
});

for (const invalidHits of ["", 0, "01", -1, 1.5, " 2 "]) {
  test(`normalizeOfflineHits rejects ${JSON.stringify(invalidHits)}`, () => {
    assert.throws(
      () => normalizeOfflineHits(invalidHits),
      new Error("딱밤 횟수는 1 이상의 정수로 입력해 주세요."),
    );
  });
}

for (const [label, invalidHits] of [
  ["a number", 1],
  ["an unsafe number", Number.MAX_SAFE_INTEGER + 1],
  ["a bigint", 2n],
  ["an array", ["2"]],
  ["an object", { toString: () => "2" }],
]) {
  test(`normalizeOfflineHits rejects ${label} before coercion`, () => {
    assert.throws(
      () => normalizeOfflineHits(invalidHits),
      new Error("딱밤 횟수는 1 이상의 정수로 입력해 주세요."),
    );
  });
}

test("mapOfflineParties maps i_hit to the current user as creditor", () => {
  assert.deepEqual(mapOfflineParties("me", "them", "i_hit"), {
    creditorId: "me",
    debtorId: "them",
  });
});

test("mapOfflineParties maps i_owe to the counterparty as creditor", () => {
  assert.deepEqual(mapOfflineParties("me", "them", "i_owe"), {
    creditorId: "them",
    debtorId: "me",
  });
});

test("mapOfflineParties rejects selecting the current user", () => {
  assert.throws(
    () => mapOfflineParties("same", "same", "i_hit"),
    new Error("본인은 선택할 수 없어요."),
  );
});

test("mapOfflineParties rejects an invalid direction", () => {
  assert.throws(
    () => mapOfflineParties("me", "them", "sideways"),
    new Error("딱밤 방향을 다시 선택해 주세요."),
  );
});

test("profile search requires a trimmed name between two and twenty-four characters", () => {
  assert.equal(typeof offlineEntry.buildProfileSearchPattern, "function");
  const { buildProfileSearchPattern } = offlineEntry;
  for (const oneCharacterQuery of ["가", "%", "_", "\\"]) {
    assert.equal(buildProfileSearchPattern(oneCharacterQuery), null);
  }
  assert.equal(buildProfileSearchPattern("가".repeat(25)), null);
  assert.equal(buildProfileSearchPattern("  가나  "), "%가나%");
  assert.equal(
    buildProfileSearchPattern("가".repeat(24)),
    `%${"가".repeat(24)}%`,
  );
});

test("ILIKE search escapes percent, underscore, and backslash literally", () => {
  assert.equal(typeof offlineEntry.escapeIlikePattern, "function");
  assert.equal(typeof offlineEntry.buildProfileSearchPattern, "function");
  const { buildProfileSearchPattern, escapeIlikePattern } = offlineEntry;
  assert.equal(escapeIlikePattern("%"), "\\%");
  assert.equal(escapeIlikePattern("_"), "\\_");
  assert.equal(escapeIlikePattern("\\"), "\\\\");
  assert.equal(
    buildProfileSearchPattern(" 가%_\\나 "),
    "%가\\%\\_\\\\나%",
  );
});

test("ledger errors translate known server cases without exposing raw details", () => {
  assert.equal(typeof offlineEntry.ledgerErrorMessage, "function");
  const { ledgerErrorMessage } = offlineEntry;
  assert.equal(
    ledgerErrorMessage({ message: "Authentication required" }),
    "로그인이 만료됐어요. 다시 로그인한 뒤 시도해 주세요.",
  );
  assert.equal(
    ledgerErrorMessage({ message: "Counterparty cannot be the same account" }),
    "본인은 선택할 수 없어요.",
  );
  assert.equal(
    ledgerErrorMessage({ message: "Counterparty account not found" }),
    "선택한 계정을 찾지 못했어요. 이름으로 다시 찾아 주세요.",
  );
  assert.equal(
    ledgerErrorMessage({ message: "Hits must be a positive canonical integer" }),
    "딱밤 횟수는 1 이상의 정수로 입력해 주세요.",
  );
  assert.equal(
    ledgerErrorMessage({ message: "Invalid offline obligation direction" }),
    "딱밤 방향을 다시 선택해 주세요.",
  );
  assert.equal(
    ledgerErrorMessage({ message: "duplicate key leaked-database-detail" }),
    "딱밤 장부 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
  );
});

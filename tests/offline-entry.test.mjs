import assert from "node:assert/strict";
import test from "node:test";

import {
  mapOfflineParties,
  normalizeDisplayName,
  normalizeOfflineHits,
} from "../src/lib/ledger/offline-entry.mjs";

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

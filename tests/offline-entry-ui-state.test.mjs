import assert from "node:assert/strict";
import test from "node:test";

import * as offlineEntry from "../src/lib/ledger/offline-entry.mjs";

const profile = {
  id: "profile-1",
  display_name: "같은 이름",
  account_id: "first-account",
};

function stateApi() {
  assert.equal(
    typeof offlineEntry.createOfflineEntryUiState,
    "function",
    "createOfflineEntryUiState must be exported",
  );
  assert.equal(
    typeof offlineEntry.reduceOfflineEntryUiState,
    "function",
    "reduceOfflineEntryUiState must be exported",
  );
  return {
    createState: offlineEntry.createOfflineEntryUiState,
    reduceState: offlineEntry.reduceOfflineEntryUiState,
  };
}

test("editing a searched query clears its prior selection and feedback", () => {
  const { createState, reduceState } = stateApi();
  let state = createState(0);
  state = reduceState(state, { type: "search_started", requestToken: 1 });
  state = reduceState(state, {
    type: "search_succeeded",
    requestToken: 1,
    matches: [profile],
  });
  state = reduceState(state, { type: "profile_selected", profile });
  state = reduceState(state, { type: "hits_changed", hits: "100" });
  state = reduceState(state, {
    type: "submit_failed",
    error: "이전 요청 오류",
  });

  state = reduceState(state, {
    type: "query_changed",
    query: "다른 이름",
    requestToken: 2,
  });

  assert.equal(state.query, "다른 이름");
  assert.deepEqual(state.matches, []);
  assert.equal(state.selectedProfile, null);
  assert.equal(state.hasSearched, false);
  assert.equal(state.localError, "");
  assert.equal(state.localNotice, "");
  assert.equal(state.searchRequestToken, 2);
  assert.equal(state.hits, "100", "query edits preserve an independently entered count");
});

test("closing resets entry state and invalidates its pending search token", () => {
  const { createState, reduceState } = stateApi();
  let state = createState(3);
  state = reduceState(state, {
    type: "query_changed",
    query: "홍길동",
    requestToken: 4,
  });
  state = reduceState(state, { type: "search_started", requestToken: 5 });
  state = reduceState(state, {
    type: "reset",
    requestToken: 6,
  });

  assert.deepEqual(state, createState(6));

  const afterStaleCompletion = reduceState(state, {
    type: "search_succeeded",
    requestToken: 5,
    matches: [profile],
  });
  assert.strictEqual(afterStaleCompletion, state);
});

test("a stale completion cannot repopulate results after a query edit", () => {
  const { createState, reduceState } = stateApi();
  let state = createState(0);
  state = reduceState(state, {
    type: "query_changed",
    query: "같은 이름",
    requestToken: 1,
  });
  state = reduceState(state, { type: "search_started", requestToken: 2 });
  state = reduceState(state, {
    type: "query_changed",
    query: "새 이름",
    requestToken: 3,
  });

  const afterStaleCompletion = reduceState(state, {
    type: "search_succeeded",
    requestToken: 2,
    matches: [profile],
  });

  assert.strictEqual(afterStaleCompletion, state);
  assert.equal(afterStaleCompletion.query, "새 이름");
  assert.deepEqual(afterStaleCompletion.matches, []);
  assert.equal(afterStaleCompletion.selectedProfile, null);
});

test("failed submission keeps entry context under one local error owner", () => {
  const { createState, reduceState } = stateApi();
  let state = createState(0);
  state = reduceState(state, {
    type: "query_changed",
    query: "같은 이름",
    requestToken: 1,
  });
  state = reduceState(state, {
    type: "search_succeeded",
    requestToken: 1,
    matches: [profile],
  });
  state = reduceState(state, { type: "profile_selected", profile });
  state = reduceState(state, { type: "hits_changed", hits: "9007199254740993" });

  state = reduceState(state, {
    type: "submit_failed",
    error: "안전한 오류",
  });

  assert.equal(state.localError, "안전한 오류");
  assert.equal(state.localNotice, "");
  assert.equal(state.selectedProfile, profile);
  assert.equal(state.hits, "9007199254740993");
  assert.equal(Object.hasOwn(state, "parentError"), false);
  assert.equal(Object.hasOwn(state, "ledgerError"), false);
});

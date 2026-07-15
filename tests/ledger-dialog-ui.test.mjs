import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { normalizeOfflineHits } from "../src/lib/ledger/offline-entry.mjs";

const source = await readFile(
  new URL("../src/components/hit-ledger-dialog.tsx", import.meta.url),
  "utf8",
);
const panelSource = await readFile(
  new URL("../src/components/account-room-panel.tsx", import.meta.url),
  "utf8",
);
const globalSource = await readFile(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8",
);
const sourceFile = ts.createSourceFile(
  "hit-ledger-dialog.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const panelSourceFile = ts.createSourceFile(
  "account-room-panel.tsx",
  panelSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const styleSource = source.slice(source.indexOf("<style jsx global>"));

function findFunction(ast, name) {
  let match;

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  return match;
}

function findCallCallback(ast, name) {
  let match;

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name &&
      node.arguments[0] &&
      (ts.isArrowFunction(node.arguments[0]) ||
        ts.isFunctionExpression(node.arguments[0]))
    ) {
      match = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  return match;
}

test("offers explicit direction and name-driven account selection", () => {
  assert.match(source, /오프라인 빚 추가/);
  assert.match(source, /name="offline-direction"[\s\S]*value="i_hit"[\s\S]*내가 때릴/);
  assert.match(source, /name="offline-direction"[\s\S]*value="i_owe"[\s\S]*내가 맞을/);
  assert.match(
    source,
    /<label htmlFor="offline-profile-query">\s*이름\s*<\/label>/,
  );
  assert.match(source, /placeholder="이름으로 계정 찾기"/);
  assert.match(source, /<b>\{profile\.display_name\}<\/b>/);
  assert.doesNotMatch(source, /@\{profile\.account_id\}/);
  assert.match(
    source,
    /aria-pressed=\{entryState\.selectedProfile\?\.id === profile\.id\}/,
  );
  assert.doesNotMatch(
    source,
    /profile\.(?:email|avatar_url|created_at|updated_at|games_played|games_won)/,
  );
});

test("renders a searchable global ledger with names only", () => {
  assert.match(
    source,
    /<h2 id="ledger-dialog-title">전체 딱밤 장부<\/h2>/,
  );
  assert.match(source, /id="global-ledger-query"/);
  assert.match(source, /placeholder="때릴 사람 또는 맞을 사람 이름"/);
  assert.match(
    source,
    /filterObligationsByName\(\s*obligations,\s*names,\s*ledgerQuery,?\s*\)/,
  );
  assert.match(source, /visibleObligations\.length/);
  assert.match(source, /obligations\.length/);
  assert.match(source, /검색한 이름과 일치하는 장부가 없어요/);
  assert.match(source, /setLedgerQuery\(""\)/);
});

test("uses the behavioral state helper that owns selection and stale results", () => {
  assert.match(source, /createOfflineEntryUiState/);
  assert.match(source, /reduceOfflineEntryUiState/);
  assert.match(
    source,
    /useReducer\([\s\S]*reduceOfflineEntryUiState[\s\S]*createOfflineEntryUiState/,
  );
  assert.match(
    source,
    /type: "query_changed"[\s\S]*requestToken/,
  );
  assert.match(
    source,
    /searchRequestRef\.current \+= 1[\s\S]*type: "reset"/,
  );
});

test("validates searches and canonical arbitrary-precision counts before callbacks", () => {
  assert.equal(
    normalizeOfflineHits("900719925474099312345678901234567890"),
    "900719925474099312345678901234567890",
  );

  const search = findFunction(sourceFile, "handleSearch");
  const submit = findFunction(sourceFile, "handleSubmit");
  assert.ok(search, "handleSearch must exist");
  assert.ok(submit, "handleSubmit must exist");

  const searchText = search.getText(sourceFile);
  assert.match(searchText, /normalizeDisplayName\(entryState\.query\)/);
  assert.match(searchText, /await onSearchProfiles\(normalizedQuery\)/);
  assert.ok(
    searchText.indexOf("normalizeDisplayName(entryState.query)") <
      searchText.indexOf("onSearchProfiles(normalizedQuery)"),
  );
  assert.match(searchText, /ledgerErrorMessage\(error\)/);

  const submitText = submit.getText(sourceFile);
  assert.match(submitText, /normalizeOfflineHits\(entryState\.hits\)/);
  assert.match(
    submitText,
    /await onAddOfflineObligation\(\{[\s\S]*counterpartyId: entryState\.selectedProfile\.id,[\s\S]*direction: entryState\.direction,[\s\S]*hits: normalizedHits/,
  );
  assert.match(source, /inputMode="numeric"/);
  assert.match(
    source,
    /const submitDisabled =[\s\S]*busy[\s\S]*searchBusy[\s\S]*submitBusy[\s\S]*!entryState\.selectedProfile[\s\S]*normalizedHits === null/,
  );
  assert.doesNotMatch(source, /id="offline-hits"[\s\S]{0,180}\bmax=/);
});

test("keeps failed callback errors in one dialog alert while preserving warnings", () => {
  const submit = findFunction(sourceFile, "handleSubmit");
  const addOffline = findFunction(panelSourceFile, "addOfflineObligation");
  assert.ok(submit);
  assert.ok(addOffline);

  const submitText = submit.getText(sourceFile);
  assert.ok(
    submitText.indexOf('type: "submit_succeeded"') >
      submitText.indexOf("await onAddOfflineObligation"),
  );
  assert.match(
    submitText,
    /catch \(error\)[\s\S]*type: "submit_failed"[\s\S]*ledgerErrorMessage\(error\)/,
  );

  const addOfflineText = addOffline.getText(panelSourceFile);
  assert.doesNotMatch(addOfflineText, /setLedgerError\(safeError\.message\)/);
  assert.match(addOfflineText, /throw safeError/);
  assert.match(addOfflineText, /setLedgerError\(LEDGER_REFRESH_WARNING\)/);

  assert.match(source, /const visibleError = entryState\.localError \|\| error/);
  assert.equal(source.match(/role="alert"/g)?.length, 1);
  assert.match(source, /className="ledger-dialog__success" role="status"/);
});

test("announces search results and focuses only current completion targets", () => {
  const search = findFunction(sourceFile, "handleSearch");
  const focusEffect = findCallCallback(sourceFile, "useEffect");
  assert.ok(search);
  assert.ok(focusEffect);
  const searchText = search.getText(sourceFile);

  assert.match(source, /aria-live="polite"/);
  assert.match(source, /ref=\{queryInputRef\}/);
  assert.match(source, /firstResultRef/);
  assert.match(source, /pendingFocusRef/);
  assert.match(source, /queryInputRef\.current\?\.focus\(\)/);
  assert.match(source, /firstResultRef\.current\?\.focus\(\)/);
  assert.match(
    focusEffect.getText(sourceFile),
    /if \(busy \|\| searchBusy \|\| submitBusy\) return;[\s\S]*pendingFocusRef\.current/,
  );
  assert.match(
    searchText,
    /if \(searchRequestRef\.current !== requestToken\) return;[\s\S]*pendingFocusRef\.current/,
  );
});

test("labels ledger provenance without changing two-party counters", () => {
  assert.match(
    source,
    /item\.source === "offline" \? "오프라인" : "게임"/,
  );
  assert.match(source, /obligations\.filter\(\(item\) => item\.creditor_id === userId\)/);
  assert.match(source, /obligations\.filter\(\(item\) => item\.debtor_id === userId\)/);
  assert.match(source, /상계하지 않고 각각 남아요/);
});

test("contains long ledger values and preserves the mobile width contract", () => {
  assert.match(
    styleSource,
    /\.ledger-dialog__matches button\s*\{[^}]*min-width: 0;[^}]*\}/,
  );
  assert.match(
    styleSource,
    /\.ledger-dialog__matches b\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*\}/,
  );
  assert.match(
    styleSource,
    /\.ledger-dialog__rowTitle\s*\{[^}]*min-width: 0;[^}]*\}/,
  );
  assert.match(
    styleSource,
    /\.ledger-dialog__rowTitle b\s*\{[^}]*overflow-wrap: anywhere;[^}]*\}/,
  );
  assert.match(
    styleSource,
    /\.ledger-dialog__rowMeta\s*\{[^}]*overflow-wrap: anywhere;[^}]*\}/,
  );

  const desktopMediaIndex = styleSource.indexOf("@media (min-width: 601px)");
  const wideRuleIndex = styleSource.indexOf(".app-dialog--ledger");
  assert.ok(desktopMediaIndex >= 0);
  assert.ok(wideRuleIndex > desktopMediaIndex);
  assert.match(
    globalSource,
    /@media \(max-width: 600px\)[\s\S]*\.app-dialog--ledger\s*\{[\s\S]*width: 100%;/,
  );
  assert.match(
    styleSource,
    /@media \(max-width: 760px\)[\s\S]*\.ledger-dialog__content\s*\{[\s\S]*grid-template-columns: 1fr;/,
  );
  assert.match(styleSource, /min-height: 44px;/);
  assert.match(styleSource, /:focus-visible/);
});

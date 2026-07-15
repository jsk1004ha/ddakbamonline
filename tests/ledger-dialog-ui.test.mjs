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
const sourceFile = ts.createSourceFile(
  "hit-ledger-dialog.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function findFunction(name) {
  let match;

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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
  assert.match(source, /@\{profile\.account_id\}/);
  assert.match(
    source,
    /aria-pressed=\{selectedProfile\?\.id === profile\.id\}/,
  );
  assert.doesNotMatch(
    source,
    /profile\.(?:email|avatar_url|created_at|updated_at|games_played|games_won)/,
  );
});

test("validates searches and canonical arbitrary-precision counts before callbacks", () => {
  assert.equal(
    normalizeOfflineHits("900719925474099312345678901234567890"),
    "900719925474099312345678901234567890",
  );

  const search = findFunction("handleSearch");
  const submit = findFunction("handleSubmit");
  assert.ok(search, "handleSearch must exist");
  assert.ok(submit, "handleSubmit must exist");

  const searchText = search.getText(sourceFile);
  assert.match(searchText, /normalizeDisplayName\(query\)/);
  assert.match(searchText, /await onSearchProfiles\(normalizedQuery\)/);
  assert.ok(
    searchText.indexOf("normalizeDisplayName(query)") <
      searchText.indexOf("onSearchProfiles(normalizedQuery)"),
  );
  assert.match(searchText, /ledgerErrorMessage\(error\)/);

  const submitText = submit.getText(sourceFile);
  assert.match(submitText, /normalizeOfflineHits\(hits\)/);
  assert.match(
    submitText,
    /await onAddOfflineObligation\(\{[\s\S]*counterpartyId: selectedProfile\.id,[\s\S]*direction,[\s\S]*hits: normalizedHits/,
  );
  assert.match(source, /inputMode="numeric"/);
  assert.match(
    source,
    /const submitDisabled =[\s\S]*busy[\s\S]*searchBusy[\s\S]*submitBusy[\s\S]*!selectedProfile[\s\S]*normalizedHits === null/,
  );
  assert.doesNotMatch(source, /id="offline-hits"[\s\S]{0,180}\bmax=/);
});

test("clears entry state only after confirmed success and safely retains failures", () => {
  const submit = findFunction("handleSubmit");
  const close = findFunction("handleClose");
  assert.ok(submit);
  assert.ok(close);

  const submitText = submit.getText(sourceFile);
  const callbackIndex = submitText.indexOf("await onAddOfflineObligation");
  for (const reset of [
    'setQuery("")',
    "setMatches([])",
    "setSelectedProfile(null)",
    'setHits("")',
  ]) {
    assert.ok(
      submitText.indexOf(reset) > callbackIndex,
      `${reset} must happen only after the callback resolves`,
    );
  }
  assert.match(
    submitText,
    /setLocalNotice\("오프라인 딱밤 빚을 양쪽 장부에 추가했어요\."\)/,
  );

  const catchClause = submit.body.statements.find(ts.isTryStatement)?.catchClause;
  assert.ok(catchClause, "submission failures must be handled locally");
  const catchText = catchClause.getText(sourceFile);
  assert.match(catchText, /setLocalError\(ledgerErrorMessage\(error\)\)/);
  assert.doesNotMatch(
    catchText,
    /setQuery\(""\)|setMatches\(\[\]\)|setSelectedProfile\(null\)|setHits\(""\)/,
  );

  assert.match(source, /className="ledger-dialog__localError" role="alert"/);
  assert.match(source, /className="ledger-dialog__success" role="status"/);
  assert.match(close.getText(sourceFile), /resetEntryState\(\)[\s\S]*onClose\(\)/);
  assert.match(panelSource, /<HitLedgerDialog[\s\S]*key=\{user\.id\}/);
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

test("uses responsive columns, 44px controls, and visible focus treatment", () => {
  assert.match(
    source,
    /\.ledger-dialog__content\s*\{[\s\S]*display: grid;[\s\S]*grid-template-columns:/,
  );
  assert.match(
    source,
    /@media \(max-width: 760px\)[\s\S]*\.ledger-dialog__content\s*\{[\s\S]*grid-template-columns: 1fr;/,
  );
  assert.match(source, /min-height: 44px;/);
  assert.match(source, /:focus-visible/);
});

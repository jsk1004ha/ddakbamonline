import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../src/components/account-room-panel.tsx", import.meta.url),
  "utf8",
);
const sourceFile = ts.createSourceFile(
  "account-room-panel.tsx",
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

function readCallChain(call) {
  if (!ts.isCallExpression(call)) return [];
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return [{ name: callee.text, args: [...call.arguments], call }];
  }
  if (!ts.isPropertyAccessExpression(callee)) return [];

  const prefix = ts.isCallExpression(callee.expression)
    ? readCallChain(callee.expression)
    : [];
  return [
    ...prefix,
    { name: callee.name.text, args: [...call.arguments], call },
  ];
}

function collectCallChains(root) {
  const chains = [];

  function visit(node) {
    if (ts.isCallExpression(node)) chains.push(readCallChain(node));
    ts.forEachChild(node, visit);
  }

  visit(root);
  return chains;
}

function literalText(node) {
  if (!node) return undefined;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function namedStep(chain, name) {
  return chain.find((step) => step.name === name);
}

test("searches other profiles by trimmed display name in a stable bounded order", () => {
  const searchFunction = findFunction("searchProfilesByName");
  assert.ok(searchFunction, "searchProfilesByName must exist");

  const functionText = searchFunction.getText(sourceFile);
  assert.match(functionText, /query\.trim\(\)/);
  assert.match(functionText, /if \(!normalized\) return \[\];/);

  const searchChain = collectCallChains(searchFunction).find((chain) => {
    const from = namedStep(chain, "from");
    return literalText(from?.args[0]) === "profiles" && namedStep(chain, "limit");
  });
  assert.ok(searchChain, "profile query chain must exist");

  const ilike = namedStep(searchChain, "ilike");
  assert.equal(literalText(ilike?.args[0]), "display_name");
  assert.equal(ilike?.args[1]?.getText(sourceFile), "`%${normalized}%`");

  const neq = namedStep(searchChain, "neq");
  assert.equal(literalText(neq?.args[0]), "id");
  assert.equal(neq?.args[1]?.getText(sourceFile), "user.id");

  const orderColumns = searchChain
    .filter((step) => step.name === "order")
    .map((step) => literalText(step.args[0]));
  assert.deepEqual(orderColumns, ["display_name", "id"]);

  const limit = namedStep(searchChain, "limit");
  assert.equal(limit?.args[0]?.getText(sourceFile), "8");
});

test("normalizes offline hits before using only the authenticated creation RPC", () => {
  const addFunction = findFunction("addOfflineObligation");
  assert.ok(addFunction, "addOfflineObligation must exist");

  const calls = collectCallChains(addFunction);
  const normalizeCall = calls
    .flatMap((chain) => chain)
    .find((step) => step.name === "normalizeOfflineHits")?.call;
  const rpcStep = calls
    .flatMap((chain) => chain)
    .find(
      (step) =>
        step.name === "rpc" &&
        literalText(step.args[0]) === "add_offline_hit_obligation",
    );

  assert.ok(normalizeCall, "normalizeOfflineHits must validate before the request");
  assert.ok(rpcStep, "add_offline_hit_obligation RPC must be called");
  assert.ok(normalizeCall.getStart(sourceFile) < rpcStep.call.getStart(sourceFile));

  const rpcInput = rpcStep.args[1];
  assert.ok(ts.isObjectLiteralExpression(rpcInput));
  const inputProperties = Object.fromEntries(
    rpcInput.properties.map((property) => {
      assert.ok(ts.isPropertyAssignment(property));
      return [property.name.getText(sourceFile), property.initializer.getText(sourceFile)];
    }),
  );
  assert.deepEqual(inputProperties, {
    counterparty_id: "input.counterpartyId",
    direction: "input.direction",
    hits: "normalizedHits",
  });

  const functionText = addFunction.getText(sourceFile);
  assert.match(functionText, /await refreshAccount\(user\.id\)/);
  assert.match(functionText, /setLedgerError\(errorMessage\(error\)\)/);
  assert.match(functionText, /throw error/);
  assert.match(functionText, /finally\s*{\s*setLedgerBusy\(false\);\s*}/);
});

test("passes offline callbacks to the ledger dialog and never inserts obligations directly", () => {
  let ledgerDialog;

  function visit(node) {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "HitLedgerDialog"
    ) {
      ledgerDialog = node;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  assert.ok(ledgerDialog, "HitLedgerDialog invocation must exist");

  const attributes = Object.fromEntries(
    ledgerDialog.attributes.properties
      .filter(ts.isJsxAttribute)
      .map((attribute) => [attribute.name.getText(sourceFile), attribute]),
  );
  assert.ok(attributes.onSearchProfiles);
  assert.ok(attributes.onAddOfflineObligation);

  const directInsert = collectCallChains(sourceFile).find((chain) => {
    const from = namedStep(chain, "from");
    return (
      literalText(from?.args[0]) === "hit_obligations" &&
      chain.some((step) => step.name === "insert")
    );
  });
  assert.equal(directInsert, undefined);
});

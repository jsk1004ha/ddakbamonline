import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
const dialogSource = await readFile(
  new URL("../src/components/hit-ledger-dialog.tsx", import.meta.url),
  "utf8",
);
const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function readSourceTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return readSourceTree(path);
      if (![".js", ".mjs", ".ts", ".tsx", ".mts"].includes(extname(path))) {
        return [];
      }
      return [{ path, source: await readFile(path, "utf8") }];
    }),
  );
  return files.flat();
}

const repositorySources = await readSourceTree(srcRoot);

function findFunction(name) {
  let match;

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      const initializer = node.initializer;
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        match = initializer;
        return;
      }
      if (
        ts.isCallExpression(initializer) &&
        initializer.arguments[0] &&
        (ts.isArrowFunction(initializer.arguments[0]) ||
          ts.isFunctionExpression(initializer.arguments[0]))
      ) {
        match = initializer.arguments[0];
        return;
      }
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

function rootIdentifier(expression) {
  let current = expression;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function sourceFileFor(path, text) {
  const extension = extname(path);
  const kind = extension === ".tsx"
    ? ts.ScriptKind.TSX
    : extension === ".ts" || extension === ".mts"
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

test("searches other profiles with a literal safe pattern and narrow result shape", () => {
  const searchFunction = findFunction("searchProfilesByName");
  assert.ok(searchFunction, "searchProfilesByName must exist");

  const functionText = searchFunction.getText(sourceFile);
  assert.match(functionText, /buildProfileSearchPattern\(query\)/);
  assert.match(functionText, /if \(!pattern\) return \[\];/);
  assert.match(functionText, /captureAccountScope\(actorId\)/);
  assert.match(functionText, /if \(!isActiveAccount\(scope\)\) return \[\];/);

  const searchChain = collectCallChains(searchFunction).find((chain) => {
    const from = namedStep(chain, "from");
    return literalText(from?.args[0]) === "profiles" && namedStep(chain, "limit");
  });
  assert.ok(searchChain, "profile query chain must exist");

  const select = namedStep(searchChain, "select");
  assert.equal(literalText(select?.args[0]), "id,display_name,account_id");

  const ilike = namedStep(searchChain, "ilike");
  assert.equal(literalText(ilike?.args[0]), "display_name");
  assert.equal(ilike?.args[1]?.getText(sourceFile), "pattern");

  const neq = namedStep(searchChain, "neq");
  assert.equal(literalText(neq?.args[0]), "id");
  assert.equal(neq?.args[1]?.getText(sourceFile), "actorId");

  const orderColumns = searchChain
    .filter((step) => step.name === "order")
    .map((step) => literalText(step.args[0]));
  assert.deepEqual(orderColumns, ["display_name", "id"]);

  const limit = namedStep(searchChain, "limit");
  assert.equal(limit?.args[0]?.getText(sourceFile), "8");
});

test("loads and subscribes to one authenticated global ledger", () => {
  const refresh = findFunction("refreshLedger");
  assert.ok(refresh, "refreshLedger must exist");
  const refreshText = refresh.getText(sourceFile);
  assert.match(
    refreshText,
    /\.from\("hit_obligations"\)[\s\S]*\.select\("\*"\)[\s\S]*\.order\("created_at"/,
  );
  assert.doesNotMatch(refreshText, /\.or\(/);

  assert.equal(source.match(/table: "hit_obligations"/g)?.length, 1);
  assert.doesNotMatch(
    source,
    /table: "hit_obligations", filter:/,
  );
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
  assert.match(functionText, /if \(!client \|\| !actorId\)/);
  assert.match(functionText, /if \(offlineMutationRef\.current\)/);
  assert.match(functionText, /throw new Error\(/);
  assert.match(functionText, /token: Symbol\(\)/);
  assert.match(functionText, /offlineMutationRef\.current = operation/);
  assert.ok(
    functionText.indexOf("offlineMutationRef.current = operation") <
      functionText.indexOf('.rpc("add_offline_hit_obligation"'),
  );
  assert.match(functionText, /if \(!isCurrentMutation\(operation\)\) return/);
  assert.match(
    functionText,
    /const \{ data, error \} = await client\.rpc\("add_offline_hit_obligation"/,
  );
  assert.match(
    functionText,
    /setObligations\(\(current\) => mergeObligationById\(current, created\)\)/,
  );
  assert.match(
    functionText,
    /await loadProfiles\(\[created\.debtor_id, created\.creditor_id\], scope\)/,
  );
  assert.match(functionText, /await refreshLedger\(scope\)/);
  assert.ok(
    functionText.indexOf("mergeObligationById") <
      functionText.indexOf("await refreshLedger(scope)"),
  );
  assert.doesNotMatch(functionText, /await refreshAccount\(actorId, scope\)/);
  assert.match(functionText, /LEDGER_REFRESH_WARNING/);
  assert.match(
    functionText,
    /catch\s*{[\s\S]*setLedgerError\(LEDGER_REFRESH_WARNING\)[\s\S]*return;/,
  );
  assert.match(functionText, /ledgerErrorMessage\(error\)/);
  assert.doesNotMatch(functionText, /throw error/);
  assert.match(
    functionText,
    /finally\s*{[\s\S]*if \(isCurrentMutation\(operation\)\)[\s\S]*setLedgerBusy\(false\)/,
  );
});

test("keys ledger operations to the current account generation", () => {
  const authFunction = findFunction("applyAuthenticatedUser");
  assert.ok(authFunction, "auth changes must synchronously update operation ownership");
  const authText = authFunction.getText(sourceFile);
  assert.match(authText, /activeAccountRef\.current/);
  assert.match(authText, /generation: current\.generation \+ 1/);
  assert.match(authText, /offlineMutationRef\.current = null/);
  assert.match(authText, /setLedgerBusy\(false\)/);
  assert.match(authText, /setLedgerError\(""\)/);

  for (const name of [
    "loadProfiles",
    "refreshLedger",
    "refreshRoom",
    "refreshAccount",
  ]) {
    const refreshFunction = findFunction(name);
    assert.ok(refreshFunction, `${name} must exist`);
    assert.match(
      refreshFunction.getText(sourceFile),
      /scope[^)]*AccountScope[\s\S]*!isActiveAccount\(scope\)/,
      `${name} must discard stale account work after awaits`,
    );
  }
});

test("deduplicates repeated auth events for the same account", () => {
  const authFunction = findFunction("applyAuthenticatedUser");
  assert.ok(authFunction, "auth changes must have one account transition gate");
  const authText = authFunction.getText(sourceFile);
  const duplicateGuard = authText.indexOf(
    "if (current.userId === nextUserId) return;",
  );
  const userUpdate = authText.indexOf("setUser(nextUser)");

  assert.notEqual(duplicateGuard, -1, "same-account auth events must be ignored");
  assert.notEqual(userUpdate, -1, "real account changes must still update the user");
  assert.ok(duplicateGuard < userUpdate, "deduplication must happen before setUser");
});

test("passes narrow shared offline callbacks to the ledger dialog", () => {
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

  assert.match(dialogSource, /ProfileSearchResult/);
  assert.match(dialogSource, /AddOfflineObligationInput/);
  assert.doesNotMatch(dialogSource, /Promise<Profile\[\]>/);
});

test("repository source creates offline obligations only through the RPC", () => {
  const violations = [];
  let hasOfflineRpc = false;

  for (const file of repositorySources) {
    const ast = sourceFileFor(file.path, file.source);
    const aliases = new Set();
    let changed = true;

    while (changed) {
      changed = false;
      function collectAliases(node) {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer
        ) {
          const initializer = node.initializer;
          const chain = ts.isCallExpression(initializer)
            ? readCallChain(initializer)
            : [];
          const from = namedStep(chain, "from");
          const initializedFromLedger =
            literalText(from?.args[0]) === "hit_obligations";
          const initializedFromAlias =
            (ts.isIdentifier(initializer) && aliases.has(initializer.text)) ||
            (ts.isCallExpression(initializer) &&
              aliases.has(rootIdentifier(initializer.expression)));
          if (
            (initializedFromLedger || initializedFromAlias) &&
            !aliases.has(node.name.text)
          ) {
            aliases.add(node.name.text);
            changed = true;
          }
        }
        ts.forEachChild(node, collectAliases);
      }
      collectAliases(ast);
    }

    function inspect(node) {
      if (ts.isCallExpression(node)) {
        const chain = readCallChain(node);
        const rpc = namedStep(chain, "rpc");
        if (literalText(rpc?.args[0]) === "add_offline_hit_obligation") {
          hasOfflineRpc = true;
        }

        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const from = namedStep(chain, "from");
          const directLedgerBuilder =
            literalText(from?.args[0]) === "hit_obligations";
          const aliasedLedgerBuilder = aliases.has(
            rootIdentifier(node.expression.expression),
          );
          if (
            ["insert", "upsert"].includes(method) &&
            (directLedgerBuilder || aliasedLedgerBuilder)
          ) {
            violations.push(
              `${relative(srcRoot, file.path)}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`,
            );
          }
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
  }

  assert.equal(violations.length, 0, violations.join("\n"));
  assert.equal(hasOfflineRpc, true);
});

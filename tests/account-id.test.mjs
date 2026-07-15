import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/auth/account-id.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  accountIdEmail,
  normalizeAccountId,
  validateAccountId,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("normalizes account IDs by trimming and lowercasing", () => {
  assert.equal(normalizeAccountId("  Player_01  "), "player_01");
});

test("accepts valid account IDs", () => {
  assert.equal(validateAccountId("abcd"), true);
  assert.equal(validateAccountId("player_01"), true);
});

test("rejects account IDs outside the supported format", () => {
  for (const accountId of [
    "abc",
    "a".repeat(21),
    "한글id",
    "user-name",
    "user name",
  ]) {
    assert.equal(validateAccountId(accountId), false, accountId);
  }
});

test("creates the internal account email from a normalized ID", () => {
  assert.equal(accountIdEmail(" Player_01 "), "player_01@accounts.ddakbam.invalid");
});

test("rejects invalid IDs when creating an account email", () => {
  assert.throws(() => accountIdEmail("bad-id"), /아이디/);
});

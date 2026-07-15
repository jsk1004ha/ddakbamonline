import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/auth/account-id.ts", import.meta.url), "utf8");
const authDialogSource = await readFile(
  new URL("../src/components/account-auth-dialog.tsx", import.meta.url),
  "utf8",
);
const roomPanelSource = await readFile(
  new URL("../src/components/account-room-panel.tsx", import.meta.url),
  "utf8",
);
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

test("keeps account authentication ID-only in the user-facing UI", () => {
  const authSources = `${authDialogSource}\n${roomPanelSource}`;

  assert.doesNotMatch(authDialogSource, /type=["']email["']/);
  assert.doesNotMatch(authDialogSource, /autoComplete=["']email["']/);
  assert.doesNotMatch(authSources, /payload\.email/);
  assert.doesNotMatch(authSources, /이메일/);
  assert.doesNotMatch(roomPanelSource, /emailRedirectTo/);
  assert.doesNotMatch(roomPanelSource, /user\.email/);
  assert.match(authDialogSource, /loginId/);
  assert.match(authDialogSource, /type=["']text["']/);
  assert.match(authDialogSource, /minLength=\{4\}/);
  assert.match(authDialogSource, /maxLength=\{20\}/);
  assert.match(authDialogSource, /pattern=["']\[A-Za-z0-9_\]\{4,20\}["']/);
  assert.match(authDialogSource, /autoCapitalize=["']none["']/);
  assert.match(authDialogSource, /spellCheck=\{false\}/);
  assert.match(authDialogSource, /autoComplete=["']username["']/);
  assert.match(authDialogSource, /minLength=\{8\}/);
  assert.match(roomPanelSource, /accountIdEmail\(payload\.loginId\)/);
  assert.match(roomPanelSource, /setAuthError\(authErrorMessage\(error\)\)/);
});

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

test("normalizes account IDs by trimming, lowercasing, and composing Hangul", () => {
  assert.equal(normalizeAccountId("  Player_01  "), "player_01");
  assert.equal(normalizeAccountId("  한글  "), "한글");
});

test("accepts valid account IDs", () => {
  assert.equal(validateAccountId("ab"), true);
  assert.equal(validateAccountId("player_01"), true);
  assert.equal(validateAccountId("한글"), true);
  assert.equal(validateAccountId("딱밤_01"), true);
});

test("rejects account IDs outside the supported format", () => {
  for (const accountId of [
    "a",
    "a".repeat(21),
    "user-name",
    "user name",
    "아이디🙂",
  ]) {
    assert.equal(validateAccountId(accountId), false, accountId);
  }
});

test("keeps the legacy internal email for ASCII account IDs", async () => {
  assert.equal(
    await accountIdEmail(" Player_01 "),
    "player_01@accounts.ddakbamonline.com",
  );
});

test("creates a deterministic opaque internal email for Korean account IDs", async () => {
  const email = await accountIdEmail(" 한글아이디 ");

  assert.match(email, /^u-[a-z0-9_-]{43}@accounts\.ddakbamonline\.com$/);
  assert.equal(email, await accountIdEmail("한글아이디"));
  assert.doesNotMatch(email, /한글아이디/);
});

test("rejects invalid IDs when creating an account email", async () => {
  await assert.rejects(() => accountIdEmail("bad-id"), /아이디/);
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
  assert.match(authDialogSource, /minLength=\{2\}/);
  assert.match(authDialogSource, /maxLength=\{20\}/);
  assert.match(authDialogSource, /pattern=["']\[A-Za-z0-9_가-힣\]\{2,20\}["']/);
  assert.match(authDialogSource, /autoCapitalize=["']none["']/);
  assert.match(authDialogSource, /spellCheck=\{false\}/);
  assert.match(authDialogSource, /autoComplete=["']username["']/);
  assert.match(authDialogSource, /minLength=\{8\}/);
  assert.match(roomPanelSource, /await accountIdEmail\(accountId\)/);
  assert.match(roomPanelSource, /data:\s*\{\s*display_name:\s*cleanName,\s*account_id:\s*accountId\s*\}/);
  assert.match(roomPanelSource, /setAuthError\(authErrorMessage\(error\)\)/);
});

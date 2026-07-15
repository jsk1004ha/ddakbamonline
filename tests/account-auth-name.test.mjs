import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authDialogSource = await readFile(
  new URL("../src/components/account-auth-dialog.tsx", import.meta.url),
  "utf8",
);
const roomPanelSource = await readFile(
  new URL("../src/components/account-room-panel.tsx", import.meta.url),
  "utf8",
);

const signupBlockStart = authDialogSource.indexOf('{mode === "signup" && (');
const signupBlockEnd = authDialogSource.indexOf("\n          )}", signupBlockStart);
const signupBlock = authDialogSource.slice(signupBlockStart, signupBlockEnd);
const signupBranchStart = roomPanelSource.indexOf(
  'if (payload.mode === "signup") {',
);
const signupBranchEnd = roomPanelSource.indexOf(
  "      } else {",
  signupBranchStart,
);
const signupBranch = roomPanelSource.slice(
  signupBranchStart,
  signupBranchEnd,
);

test("signup asks for a required 이름 with the existing input constraints", () => {
  assert.notEqual(signupBlockStart, -1, "signup block should exist");
  assert.notEqual(signupBlockEnd, -1, "signup block should be complete");
  assert.match(signupBlock, />\s*이름\s*<input/);
  assert.match(signupBlock, /\brequired\b/);
  assert.match(signupBlock, /minLength=\{2\}/);
  assert.match(signupBlock, /maxLength=\{24\}/);
  assert.match(signupBlock, /autoComplete="nickname"/);
  assert.doesNotMatch(signupBlock, /닉네임/);
});

test("account signup validates and stores the normalized display name", () => {
  assert.notEqual(signupBranchStart, -1, "signup branch should exist");
  assert.notEqual(signupBranchEnd, -1, "signup branch should be complete");
  assert.match(
    signupBranch,
    /const cleanName = normalizeDisplayName\(payload\.displayName\);/,
  );
  assert.match(
    signupBranch,
    /data:\s*\{\s*display_name:\s*cleanName,\s*account_id:\s*accountId\s*\}/,
  );
  assert.ok(
    signupBranch.indexOf("normalizeDisplayName(payload.displayName)") <
      signupBranch.indexOf("supabase.auth.signUp"),
    "display name should be validated before signup",
  );
});

test("account errors pass through 아이디 and 이름 validation messages", () => {
  assert.match(
    roomPanelSource,
    /if \(\/\^\(\?:아이디\|이름\)\/\.test\(error\.message\)\) return error\.message;/,
  );
});

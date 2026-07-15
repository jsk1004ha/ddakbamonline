import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(
  new URL("../scripts/live-authority-qa.mjs", import.meta.url),
  "utf8",
);

test("live authority QA provisions disposable users and always cleans them up", () => {
  assert.match(script, /"SUPABASE_SERVICE_ROLE_KEY"/);
  assert.match(script, /auth\.admin\.createUser/);
  assert.match(script, /try\s*\{/);
  assert.match(script, /finally\s*\{[\s\S]*cleanupQaData\(\)/);
  assert.match(script, /auth\.admin\.deleteUser/);
  assert.doesNotMatch(script, /"QA_HOST_ID"|"QA_GUEST_ID"/);
});

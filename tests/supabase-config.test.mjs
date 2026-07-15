import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = await readFile(
  new URL("../supabase/config.toml", import.meta.url),
  "utf8",
);

test("hosted ID auth uses production redirects and server-side password rules", () => {
  assert.match(
    config,
    /site_url\s*=\s*"https:\/\/ddakbamonline-live\.vercel\.app"/,
  );
  assert.match(config, /minimum_password_length\s*=\s*8/);
  assert.match(
    config,
    /\[auth\.email\][\s\S]*?enable_confirmations\s*=\s*false/,
  );
});

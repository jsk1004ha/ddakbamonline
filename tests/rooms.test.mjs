import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/rooms.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  canStartRoom,
  findFirstFreeSeat,
  generateRoomCode,
  normalizeRoomCode,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("normalizes room codes to the six supported uppercase characters", () => {
  assert.equal(normalizeRoomCode(" ab-12z9 "), "AB2Z9");
  assert.equal(normalizeRoomCode("o0i1l"), "OIL");
  assert.equal(normalizeRoomCode("abcdefghi"), "ABCDEF");
});

test("generates a six-character room code without ambiguous characters", () => {
  const code = generateRoomCode(() => 0);
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(code.length, 6);
});

test("returns the first seat not occupied below the room maximum", () => {
  assert.equal(findFirstFreeSeat([{ seat: 1 }, { seat: 0 }], 4), 2);
  assert.equal(findFirstFreeSeat([{ seat: 0 }, { seat: 2 }], 3), 1);
  assert.equal(findFirstFreeSeat([{ seat: 0 }, { seat: 1 }], 2), null);
});

test("a host can start only with two to four ready members", () => {
  assert.equal(canStartRoom([{ ready: true }], 4), false);
  assert.equal(canStartRoom([{ ready: true }, { ready: true }], 4), true);
  assert.equal(canStartRoom([{ ready: true }, { ready: false }], 4), false);
  assert.equal(
    canStartRoom(
      [{ ready: true }, { ready: true }, { ready: true }, { ready: true }],
      4,
    ),
    true,
  );
  assert.equal(
    canStartRoom(
      [
        { ready: true },
        { ready: true },
        { ready: true },
        { ready: true },
        { ready: true },
      ],
      4,
    ),
    false,
  );
});

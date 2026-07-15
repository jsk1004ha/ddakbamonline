import test from "node:test";
import assert from "node:assert/strict";
import { COMPACT_HAND_RANKING, handRankingGroup } from "../src/lib/game/hand-ranking.mjs";

test("compact ranking keeps the approved Korean copy and order", () => {
  assert.deepEqual(COMPACT_HAND_RANKING, [
    { id: "gwang", label: "광땡", summary: "38광땡 〉 18광땡 〉 13광땡" },
    { id: "ddang", label: "땡", summary: "10땡 〉 … 〉 1땡" },
    { id: "special", label: "특수패", summary: "알리 〉 독사 〉 구삥 〉 장삥 〉 장사 〉 세륙" },
    { id: "kkeut", label: "끗", summary: "갑오 〉 8끗 〉 … 〉 1끗 〉 망통" },
  ]);
});

test("hand names map to the group highlighted by the rollup", () => {
  assert.equal(handRankingGroup("38광땡"), "gwang");
  assert.equal(handRankingGroup("8땡"), "ddang");
  assert.equal(handRankingGroup("알리"), "special");
  assert.equal(handRankingGroup("갑오"), "kkeut");
  assert.equal(handRankingGroup("망통"), "kkeut");
});

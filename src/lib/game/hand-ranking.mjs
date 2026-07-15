export const COMPACT_HAND_RANKING = Object.freeze([
  Object.freeze({ id: "gwang", label: "광땡", summary: "38광땡 〉 18광땡 〉 13광땡" }),
  Object.freeze({ id: "ddang", label: "땡", summary: "10땡 〉 … 〉 1땡" }),
  Object.freeze({ id: "special", label: "특수패", summary: "알리 〉 독사 〉 구삥 〉 장삥 〉 장사 〉 세륙" }),
  Object.freeze({ id: "kkeut", label: "끗", summary: "갑오 〉 8끗 〉 … 〉 1끗 〉 망통" }),
]);

const SPECIAL_HANDS = new Set(["알리", "독사", "구삥", "장삥", "장사", "세륙"]);

export function handRankingGroup(name) {
  if (name.endsWith("광땡")) return "gwang";
  if (/^\d+땡$/.test(name)) return "ddang";
  if (SPECIAL_HANDS.has(name)) return "special";
  return "kkeut";
}

export type CompactHandRankingGroup = {
  readonly id: "gwang" | "ddang" | "special" | "kkeut";
  readonly label: string;
  readonly summary: string;
};

export const COMPACT_HAND_RANKING: readonly CompactHandRankingGroup[];
export function handRankingGroup(name: string): CompactHandRankingGroup["id"];

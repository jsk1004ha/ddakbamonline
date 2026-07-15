export type PublicExactQuantity = number | string;

export interface PublicHandEvaluation {
  name: string;
  rank: number;
  tiebreak: number;
  months: [number, number];
}

export interface PublicActiveBettingState {
  playerIds: string[];
  commitments: Record<string, PublicExactQuantity>;
  currentStake: PublicExactQuantity;
  pot: PublicExactQuantity;
  turnPlayerId: string;
  lastAggressorId: string | null;
  status: "betting";
  pendingPlayerIds: string[];
}

export interface PublicCompleteBettingState {
  playerIds: string[];
  commitments: Record<string, PublicExactQuantity>;
  currentStake: PublicExactQuantity;
  pot: PublicExactQuantity;
  turnPlayerId: null;
  lastAggressorId: string | null;
  status: "complete";
  pendingPlayerIds: [];
}

interface PublicRoundBase {
  schema: 2;
  roundToken: string;
  roundNumber: number;
  playerIds: string[];
}

export interface PublicBettingRoundState extends PublicRoundBase {
  betting: PublicActiveBettingState;
  phase: "betting";
  evaluations: Record<string, never>;
  winnerIds: [];
}

export interface PublicShowdownRoundState extends PublicRoundBase {
  betting: PublicCompleteBettingState;
  phase: "showdown";
  evaluations: Record<string, PublicHandEvaluation>;
  winnerIds: [string, ...string[]];
}

export type PublicOnlineRoundState =
  | PublicBettingRoundState
  | PublicShowdownRoundState;

export function readPublicOnlineRound(
  value: unknown,
): PublicOnlineRoundState | null;

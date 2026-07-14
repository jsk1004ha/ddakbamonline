export interface Card {
  id: string;
  month: number;
  variant: number;
  imageId: number;
  bright: boolean;
}

export interface EvaluatedHand {
  name: string;
  rank: number;
  tiebreak: number;
  months: number[];
}

export type ExactInteger = number | string | bigint;
export type ExactQuantity = number | string;

export interface BettingState {
  playerIds: string[];
  commitments: Record<string, ExactQuantity>;
  currentStake: ExactQuantity;
  pot: ExactQuantity;
  turnPlayerId: string | null;
  lastAggressorId: string | null;
  status: "betting" | "complete";
  pendingPlayerIds: string[];
}

export interface HitObligation {
  id: string;
  debtorId: string;
  creditorId: string;
  initial: ExactQuantity;
  remaining: ExactQuantity;
  delivered: ExactQuantity;
}

export function dealRound(playerIds: string[], rng?: () => number): Record<string, Card[]>;
export function evaluateHand(cards: Card[]): EvaluatedHand;
export function compareHands(left: EvaluatedHand, right: EvaluatedHand): number;
export function createBettingState(
  playerIds: string[],
  startingStake?: ExactInteger,
  startingPlayerIndex?: number,
): BettingState;
export function applyAction(
  state: BettingState,
  playerId: string,
  action: { type: "call" } | { type: "raise"; amount: ExactInteger },
): BettingState;
export function settleRound(
  existingObligations: HitObligation[],
  result: { winnerId: string | null; loserIds: string[]; stake: ExactInteger },
): HitObligation[];
export function recordHit(
  obligations: HitObligation[],
  obligationId: string,
): HitObligation[];
export function summarizeAccountLedger(
  obligations: HitObligation[],
  accountId: string,
): { owes: ExactQuantity; isOwed: ExactQuantity; hitsDelivered: ExactQuantity; hitsReceived: ExactQuantity };

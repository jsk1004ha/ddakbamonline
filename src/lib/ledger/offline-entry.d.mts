export type OfflineDirection = "i_hit" | "i_owe";

export function normalizeDisplayName(value: unknown): string;
export function normalizeOfflineHits(value: unknown): string;
export function mapOfflineParties(
  userId: string,
  counterpartyId: string,
  direction: OfflineDirection,
): { creditorId: string; debtorId: string };

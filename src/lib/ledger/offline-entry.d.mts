import type { ProfileSearchResult } from "./offline-entry.types";

export type OfflineDirection = "i_hit" | "i_owe";

export type OfflineEntryUiState = {
  direction: OfflineDirection;
  query: string;
  matches: ProfileSearchResult[];
  selectedProfile: ProfileSearchResult | null;
  hits: string;
  hasSearched: boolean;
  localError: string;
  localNotice: string;
  searchRequestToken: number;
};

export type OfflineEntryUiAction =
  | { type: "direction_changed"; direction: OfflineDirection }
  | { type: "query_changed"; query: string; requestToken: number }
  | { type: "hits_changed"; hits: string }
  | { type: "search_started"; requestToken: number }
  | {
      type: "search_succeeded";
      requestToken: number;
      matches: ProfileSearchResult[];
    }
  | { type: "search_failed"; requestToken: number; error: string }
  | { type: "profile_selected"; profile: ProfileSearchResult }
  | { type: "feedback_cleared" }
  | { type: "validation_failed"; error: string }
  | { type: "submit_failed"; error: string }
  | { type: "submit_succeeded"; requestToken: number; notice: string }
  | { type: "reset"; requestToken: number };

export function normalizeDisplayName(value: unknown): string;
export function normalizeOfflineHits(value: unknown): string;
export function escapeIlikePattern(value: string): string;
export function buildProfileSearchPattern(value: unknown): string | null;
export function ledgerErrorMessage(error: unknown): string;
export function mapOfflineParties(
  userId: string,
  counterpartyId: string,
  direction: OfflineDirection,
): { creditorId: string; debtorId: string };
export function createOfflineEntryUiState(
  searchRequestToken?: number,
): OfflineEntryUiState;
export function reduceOfflineEntryUiState(
  state: OfflineEntryUiState,
  action: OfflineEntryUiAction,
): OfflineEntryUiState;

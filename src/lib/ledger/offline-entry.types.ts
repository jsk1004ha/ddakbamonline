import type { Tables } from "@/lib/supabase/database.types";

export type ProfileSearchResult = Pick<
  Tables<"profiles">,
  "id" | "display_name" | "account_id"
>;

export type AddOfflineObligationInput = {
  counterpartyId: string;
  direction: "i_hit" | "i_owe";
  hits: string;
};

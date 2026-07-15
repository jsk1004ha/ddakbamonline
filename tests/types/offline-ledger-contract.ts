import type { Database } from "../../src/lib/supabase/database.types";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type Obligation = Database["public"]["Tables"]["hit_obligations"];
type ObligationRow = Obligation["Row"];
type ObligationInsert = Obligation["Insert"];
type ObligationUpdate = Obligation["Update"];

export type RowGameResultContract = Assert<
  Equal<ObligationRow["game_result_id"], string | null>
>;
export type InsertGameResultContract = Assert<
  Equal<ObligationInsert["game_result_id"], string | null | undefined>
>;
export type UpdateGameResultContract = Assert<
  Equal<ObligationUpdate["game_result_id"], string | null | undefined>
>;

export type RowSourceContract = Assert<
  Equal<ObligationRow["source"], "game" | "offline">
>;
export type InsertSourceContract = Assert<
  Equal<ObligationInsert["source"], "game" | "offline" | undefined>
>;
export type UpdateSourceContract = Assert<
  Equal<ObligationUpdate["source"], "game" | "offline" | undefined>
>;

export type RowCreatedByContract = Assert<
  Equal<ObligationRow["created_by"], string | null>
>;
export type InsertCreatedByContract = Assert<
  Equal<ObligationInsert["created_by"], string | null | undefined>
>;
export type UpdateCreatedByContract = Assert<
  Equal<ObligationUpdate["created_by"], string | null | undefined>
>;

type OfflineRpc = Database["public"]["Functions"]["add_offline_hit_obligation"];
export type ExactRpcArgsContract = Assert<
  Equal<
    OfflineRpc["Args"],
    { counterparty_id: string; direction: string; hits: string }
  >
>;
export type RpcReturnsObligationContract = Assert<
  Equal<OfflineRpc["Returns"], ObligationRow>
>;

type CreatedByRelationship = Extract<
  Obligation["Relationships"][number],
  { foreignKeyName: "hit_obligations_created_by_fkey" }
>;
export type CreatedByRelationshipContract = Assert<
  Equal<
    CreatedByRelationship,
    {
      foreignKeyName: "hit_obligations_created_by_fkey";
      columns: ["created_by"];
      isOneToOne: false;
      referencedRelation: "profiles";
      referencedColumns: ["id"];
    }
  >
>;

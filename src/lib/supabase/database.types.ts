export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          account_id: string;
          display_name: string;
          games_played: number;
          games_won: number;
          hits_delivered: number;
          hits_received: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          account_id: string;
          display_name: string;
          games_played?: number;
          games_won?: number;
          hits_delivered?: number;
          hits_received?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          account_id?: string;
          display_name?: string;
          games_played?: number;
          games_won?: number;
          hits_delivered?: number;
          hits_received?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      game_actions: {
        Row: {
          id: number;
          room_id: string;
          round_token: string;
          player_id: string;
          room_version: number;
          action_name: string;
          raise_to: string | number | null;
          created_at: string;
        };
        Insert: {
          id?: never;
          room_id: string;
          round_token: string;
          player_id: string;
          room_version: number;
          action_name: string;
          raise_to?: string | number | null;
          created_at?: string;
        };
        Update: {
          id?: never;
          room_id?: string;
          round_token?: string;
          player_id?: string;
          room_version?: number;
          action_name?: string;
          raise_to?: string | number | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "game_actions_player_id_fkey";
            columns: ["player_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "game_actions_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "game_rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      game_rooms: {
        Row: {
          id: string;
          code: string;
          host_id: string;
          max_players: number;
          status: "waiting" | "playing" | "showdown" | "closed";
          state: Json;
          version: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          host_id: string;
          max_players: number;
          status?: "waiting" | "playing" | "showdown" | "closed";
          state?: Json;
          version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          code?: string;
          host_id?: string;
          max_players?: number;
          status?: "waiting" | "playing" | "showdown" | "closed";
          state?: Json;
          version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "game_rooms_host_id_fkey";
            columns: ["host_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      room_members: {
        Row: {
          room_id: string;
          user_id: string;
          seat: number;
          ready: boolean;
          joined_at: string;
          last_seen_at: string;
        };
        Insert: {
          room_id: string;
          user_id: string;
          seat: number;
          ready?: boolean;
          joined_at?: string;
          last_seen_at?: string;
        };
        Update: {
          room_id?: string;
          user_id?: string;
          seat?: number;
          ready?: boolean;
          joined_at?: string;
          last_seen_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "game_rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "room_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      game_round_hands: {
        Row: {
          room_id: string;
          round_token: string;
          player_id: string;
          card_ids: number[];
          created_at: string;
        };
        Insert: {
          room_id: string;
          round_token: string;
          player_id: string;
          card_ids: number[];
          created_at?: string;
        };
        Update: {
          room_id?: string;
          round_token?: string;
          player_id?: string;
          card_ids?: number[];
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "game_round_hands_player_id_fkey";
            columns: ["player_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "game_round_hands_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "game_rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      game_results: {
        Row: {
          id: string;
          room_id: string | null;
          winner_id: string | null;
          player_ids: string[];
          stake: string | number;
          round_token: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          room_id?: string | null;
          winner_id?: string | null;
          player_ids: string[];
          stake: string | number;
          round_token?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          room_id?: string | null;
          winner_id?: string | null;
          player_ids?: string[];
          stake?: string | number;
          round_token?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "game_results_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "game_rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "game_results_winner_id_fkey";
            columns: ["winner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      hit_obligations: {
        Row: {
          id: string;
          game_result_id: string | null;
          room_id: string | null;
          debtor_id: string;
          creditor_id: string;
          initial_hits: string | number;
          remaining_hits: string | number;
          delivered_hits: number;
          source: "game" | "offline";
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          game_result_id?: string | null;
          room_id?: string | null;
          debtor_id: string;
          creditor_id: string;
          initial_hits: string | number;
          remaining_hits: string | number;
          delivered_hits?: number;
          source?: "game" | "offline";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          game_result_id?: string | null;
          room_id?: string | null;
          debtor_id?: string;
          creditor_id?: string;
          initial_hits?: string | number;
          remaining_hits?: string | number;
          delivered_hits?: number;
          source?: "game" | "offline";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "hit_obligations_game_result_id_fkey";
            columns: ["game_result_id"];
            isOneToOne: false;
            referencedRelation: "game_results";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "hit_obligations_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "game_rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "hit_obligations_debtor_id_fkey";
            columns: ["debtor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "hit_obligations_creditor_id_fkey";
            columns: ["creditor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "hit_obligations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      add_offline_hit_obligation: {
        Args: {
          counterparty_id: string;
          direction: "i_hit" | "i_owe";
          hits: string;
        };
        Returns: Database["public"]["Tables"]["hit_obligations"]["Row"];
      };
      close_game_room: {
        Args: { expected_version: number; target_room: string };
        Returns: Json;
      };
      expire_idle_game_room: {
        Args: { target_room: string };
        Returns: Json;
      };
      leave_game_room: {
        Args: { expected_version: number; target_room: string };
        Returns: Json;
      };
      play_game_action: {
        Args: {
          action_name: string;
          expected_version: number;
          raise_to: string | null;
          target_room: string;
        };
        Returns: Json;
      };
      record_physical_hit: {
        Args: {
          expected_remaining: string | number;
          obligation_id: string;
        };
        Returns: Json;
      };
      start_game_round: {
        Args: { expected_version: number; target_room: string };
        Returns: Json;
      };
      touch_room_presence: {
        Args: { target_room: string };
        Returns: Json;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

export type Tables<
  TableName extends keyof Database["public"]["Tables"],
> = Database["public"]["Tables"][TableName]["Row"];

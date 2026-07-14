create unique index hit_obligations_round_pair_idx
  on public.hit_obligations (game_result_id, debtor_id, creditor_id);

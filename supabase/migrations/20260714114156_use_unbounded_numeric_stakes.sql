alter table public.game_results
  alter column stake type numeric using stake::numeric;

alter table public.hit_obligations
  alter column initial_hits type numeric using initial_hits::numeric,
  alter column remaining_hits type numeric using remaining_hits::numeric;

create index game_rooms_host_id_idx on public.game_rooms (host_id);
create index game_results_room_id_idx on public.game_results (room_id);
create index game_results_winner_id_idx on public.game_results (winner_id);
create index hit_obligations_game_result_id_idx on public.hit_obligations (game_result_id);
create index hit_obligations_room_id_idx on public.hit_obligations (room_id);

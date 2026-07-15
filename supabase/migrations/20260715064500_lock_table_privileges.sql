-- Supabase projects can inherit broad default table privileges. RLS already
-- rejects unauthorized writes, but explicit least-privilege grants make the
-- authority boundary resilient to future policy changes.
revoke all privileges on table public.profiles
  from anon, authenticated;
revoke all privileges on table public.game_rooms
  from anon, authenticated;
revoke all privileges on table public.room_members
  from anon, authenticated;
revoke all privileges on table public.game_results
  from anon, authenticated;
revoke all privileges on table public.hit_obligations
  from anon, authenticated;
revoke all privileges on table public.game_round_hands
  from anon, authenticated;
revoke all privileges on table public.game_actions
  from anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

grant select, delete on table public.game_rooms to authenticated;
grant insert (code, host_id, max_players)
  on table public.game_rooms to authenticated;

grant select, delete on table public.room_members to authenticated;
grant insert (room_id, user_id, seat)
  on table public.room_members to authenticated;
grant update (ready) on table public.room_members to authenticated;

grant select on table
  public.game_results, public.hit_obligations,
  public.game_round_hands, public.game_actions
  to authenticated;

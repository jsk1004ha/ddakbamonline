-- A room deletion cascades after the parent row is no longer visible to the
-- member trigger. That missing-parent case is safe to allow; direct removal
-- from an existing room must still share the waiting-room lock with start.
create or replace function private.lock_waiting_room_member_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  room_status text;
begin
  select room.status
  into room_status
  from public.game_rooms as room
  where room.id = old.room_id
  for update;

  if not found then
    return old;
  end if;
  if room_status <> 'waiting' then
    raise exception 'Room members can be removed only while the room is waiting';
  end if;
  return old;
end;
$$;

revoke all on function private.lock_waiting_room_member_delete()
  from public, anon, authenticated;

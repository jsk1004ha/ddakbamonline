drop policy "Room members can update game state" on public.game_rooms;

create policy "Room hosts can update room status and state"
on public.game_rooms for update
to authenticated
using (private.is_room_host(id))
with check (private.is_room_host(id));

create or replace function private.record_hit_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivered_delta bigint;
begin
  delivered_delta := new.delivered_hits - old.delivered_hits;
  if delivered_delta < 0 then
    raise exception 'Delivered hit count cannot decrease';
  end if;
  if delivered_delta > 1 then
    raise exception 'Record physical hits one at a time';
  end if;

  if delivered_delta = 1 then
    update public.profiles
    set hits_delivered = hits_delivered + 1
    where id = new.debtor_id;

    update public.profiles
    set hits_received = hits_received + 1
    where id = new.creditor_id;
  end if;

  return new;
end;
$$;

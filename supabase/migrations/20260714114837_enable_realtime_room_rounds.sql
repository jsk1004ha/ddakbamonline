alter table public.game_rooms
  add column version bigint not null default 0 check (version >= 0);

alter table public.game_results
  add column round_token uuid not null default gen_random_uuid();

create unique index game_results_round_token_idx
  on public.game_results (round_token);

create or replace function private.restrict_room_status_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and old.host_id <> auth.uid() then
    raise exception 'Only the room host may change room status';
  end if;
  return new;
end;
$$;

create trigger game_rooms_restrict_status_changes
before update on public.game_rooms
for each row execute function private.restrict_room_status_changes();

drop policy "Room hosts can update room status and state" on public.game_rooms;

create policy "Room members can update synchronized game state"
on public.game_rooms for update
to authenticated
using (private.is_room_member(id))
with check (private.is_room_member(id));

grant update (version) on public.game_rooms to authenticated;
revoke all on function private.restrict_room_status_changes() from public;

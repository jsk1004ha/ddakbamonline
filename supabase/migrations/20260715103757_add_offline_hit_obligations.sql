alter table public.hit_obligations
  alter column game_result_id drop not null,
  add column source text not null default 'game',
  add column created_by uuid references public.profiles (id),
  add constraint hit_obligations_source_check check (
    (source = 'game' and game_result_id is not null and created_by is null)
    or
    (source = 'offline' and game_result_id is null and room_id is null and created_by is not null)
  );

create or replace function public.add_offline_hit_obligation(
  counterparty_id uuid,
  direction text,
  hits text
)
returns public.hit_obligations
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  debtor uuid;
  creditor uuid;
  hit_count numeric;
  created public.hit_obligations%rowtype;
begin
  actor_id := auth.uid();
  if actor_id is null then
    raise exception 'Authentication required';
  end if;

  if counterparty_id is null or counterparty_id = actor_id then
    raise exception 'Counterparty cannot be the same account';
  end if;

  if not exists (select 1 from public.profiles where id = counterparty_id) then
    raise exception 'Counterparty account not found';
  end if;

  if hits is null or hits !~ '^[1-9][0-9]*$' then
    raise exception 'Hits must be a positive canonical integer';
  end if;
  hit_count := hits::numeric;

  if direction = 'i_hit' then
    creditor := actor_id;
    debtor := counterparty_id;
  elsif direction = 'i_owe' then
    creditor := counterparty_id;
    debtor := actor_id;
  else
    raise exception 'Invalid offline obligation direction';
  end if;

  insert into public.hit_obligations (
    game_result_id,
    room_id,
    debtor_id,
    creditor_id,
    initial_hits,
    remaining_hits,
    source,
    created_by
  ) values (
    null,
    null,
    debtor,
    creditor,
    hit_count,
    hit_count,
    'offline',
    actor_id
  ) returning * into created;

  return created;
end;
$$;

revoke all on function public.add_offline_hit_obligation(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.add_offline_hit_obligation(uuid, text, text)
  to authenticated;

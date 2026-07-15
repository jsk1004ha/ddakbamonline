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
    where id = new.creditor_id;

    update public.profiles
    set hits_received = hits_received + 1
    where id = new.debtor_id;
  end if;

  return new;
end;
$$;

update public.profiles as profile
set
  hits_delivered = coalesce((
    select sum(obligation.delivered_hits)
    from public.hit_obligations as obligation
    where obligation.creditor_id = profile.id
  ), 0),
  hits_received = coalesce((
    select sum(obligation.delivered_hits)
    from public.hit_obligations as obligation
    where obligation.debtor_id = profile.id
  ), 0);

revoke all on function private.record_hit_stats() from public;

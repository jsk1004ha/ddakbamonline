drop policy if exists "Obligation parties can read their account ledger"
  on public.hit_obligations;

create policy "Authenticated accounts can read the global hit ledger"
on public.hit_obligations for select
to authenticated
using (true);

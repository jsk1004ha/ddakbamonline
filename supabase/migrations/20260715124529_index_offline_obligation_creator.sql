create index if not exists hit_obligations_created_by_idx
  on public.hit_obligations using btree (created_by);

-- Supabase Auth rejects reserved synthetic TLDs such as `.invalid` before the
-- database trigger runs. Keep the email implementation detail on a valid domain
-- while continuing to derive all public account identity from the local part.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
  requested_account_id text;
begin
  if new.email is null
    or lower(new.email) !~ '^[a-z0-9_]{4,20}@accounts\.ddakbamonline\.com$'
  then
    raise exception 'Unsupported account identity';
  end if;

  requested_account_id := split_part(lower(new.email), '@', 1);
  requested_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    requested_account_id
  );
  if char_length(requested_name) < 2 then
    requested_name := '플레이어';
  end if;

  insert into public.profiles (id, account_id, display_name)
  values (new.id, requested_account_id, left(requested_name, 24));
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

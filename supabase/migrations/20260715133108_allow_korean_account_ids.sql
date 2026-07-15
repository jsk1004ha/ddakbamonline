alter table public.profiles
  drop constraint profiles_account_id_format_check;

alter table public.profiles
  add constraint profiles_account_id_format_check
  check (
    char_length(account_id) between 2 and 20
    and account_id = normalize(account_id, NFC)
    and account_id ~ '^[가-힣a-z0-9_]+$'
  );

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
  requested_account_id text;
  email_local_part text;
  expected_email_local_part text;
begin
  if new.email is null then
    raise exception 'Unsupported account identity';
  end if;

  email_local_part := split_part(lower(new.email), '@', 1);

  if lower(new.email) <> email_local_part || '@accounts.ddakbamonline.com' then
    raise exception 'Unsupported account identity';
  end if;

  requested_account_id := normalize(
    lower(btrim(coalesce(new.raw_user_meta_data ->> 'account_id', ''))),
    NFC
  );

  if requested_account_id = '' and email_local_part ~ '^[a-z0-9_]{2,20}$' then
    requested_account_id := email_local_part;
  end if;

  if char_length(requested_account_id) not between 2 and 20
    or requested_account_id <> normalize(requested_account_id, NFC)
    or requested_account_id !~ '^[가-힣a-z0-9_]+$'
  then
    raise exception 'Unsupported account identity';
  end if;

  if requested_account_id ~ '^[a-z0-9_]+$'
    and email_local_part = requested_account_id
  then
    null;
  else
    expected_email_local_part := 'u-' || translate(
      rtrim(
        encode(
          extensions.digest(convert_to(requested_account_id, 'UTF8'), 'sha256'),
          'base64'
        ),
        '='
      ),
      '+/',
      '-_'
    );

    if email_local_part <> expected_email_local_part then
      raise exception 'Unsupported account identity';
    end if;
  end if;

  requested_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
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

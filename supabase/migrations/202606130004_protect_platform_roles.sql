-- Platform privileges must never be editable from an authenticated browser client.

create or replace function public.protect_platform_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
    and auth.uid() = old.id
    and not public.is_platform_admin()
    and (new.platform_role is distinct from old.platform_role
      or new.account_status is distinct from old.account_status) then
    raise exception 'Platform role and account status can only be changed by a platform administrator'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_protect_platform_fields on public.profiles;
create trigger profiles_protect_platform_fields
before update on public.profiles
for each row execute function public.protect_platform_profile_fields();

revoke execute on function public.protect_platform_profile_fields() from public, anon, authenticated;

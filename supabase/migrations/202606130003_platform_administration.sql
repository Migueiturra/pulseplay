-- Separate platform administration from workspace ownership.

alter table public.profiles
add column if not exists platform_role text not null default 'user'
  check (platform_role in ('user', 'super_admin')),
add column if not exists account_status text not null default 'active'
  check (account_status in ('active', 'suspended'));

update public.profiles
set platform_role = 'super_admin'
where id = '3b354d0a-d236-4af9-85cb-01d924d3b4c8';

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and platform_role = 'super_admin'
      and account_status = 'active'
  );
$$;

revoke execute on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

drop policy if exists "Platform admins read all profiles" on public.profiles;
create policy "Platform admins read all profiles"
on public.profiles for select to authenticated
using (public.is_platform_admin());

drop policy if exists "Members create invitations" on public.workspace_invitations;
create policy "Members create invitations"
on public.workspace_invitations for insert to authenticated
with check (public.is_workspace_member(workspace_id) and invited_by = auth.uid() and role = 'editor');

drop policy if exists "Owners read invitations" on public.workspace_invitations;
create policy "Members read invitations"
on public.workspace_invitations for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists "Owners delete invitations" on public.workspace_invitations;
create policy "Inviters revoke invitations"
on public.workspace_invitations for delete to authenticated
using (invited_by = auth.uid() or public.is_platform_admin());

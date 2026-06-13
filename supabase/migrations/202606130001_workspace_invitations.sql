-- Real workspace invitations and team management.

alter table public.profiles
add column if not exists email text;

update public.profiles p
set email = lower(u.email)
from auth.users u
where u.id = p.id and p.email is null;

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and char_length(email) between 3 and 320),
  role public.workspace_role not null default 'editor',
  invited_by uuid not null references public.profiles(id),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (workspace_id, email)
);

create index if not exists workspace_invitations_workspace_status_idx
on public.workspace_invitations (workspace_id, status, created_at desc);

alter table public.workspace_invitations enable row level security;

create or replace function public.shares_workspace_with(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members teammate
      on teammate.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid()
      and teammate.user_id = target_user_id
  );
$$;

revoke execute on function public.shares_workspace_with(uuid) from public, anon;
grant execute on function public.shares_workspace_with(uuid) to authenticated;

drop policy if exists "Profiles are visible to their owner" on public.profiles;
drop policy if exists "Workspace members read teammate profiles" on public.profiles;
create policy "Workspace members read teammate profiles"
on public.profiles for select to authenticated
using (id = auth.uid() or public.shares_workspace_with(id));

create policy "Owners read invitations"
on public.workspace_invitations for select to authenticated
using (public.is_workspace_owner(workspace_id));

create policy "Owners create invitations"
on public.workspace_invitations for insert to authenticated
with check (public.is_workspace_owner(workspace_id) and invited_by = auth.uid());

create policy "Owners update invitations"
on public.workspace_invitations for update to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy "Owners delete invitations"
on public.workspace_invitations for delete to authenticated
using (public.is_workspace_owner(workspace_id));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
  invited_workspace_id uuid;
  invited_role public.workspace_role;
  profile_name text;
  metadata_workspace text;
begin
  profile_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1));

  insert into public.profiles (id, name, email)
  values (new.id, profile_name, lower(new.email))
  on conflict (id) do update
  set name = excluded.name, email = excluded.email;

  metadata_workspace := new.raw_user_meta_data ->> 'workspace_id';
  if metadata_workspace ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    select wi.workspace_id, wi.role
      into invited_workspace_id, invited_role
    from public.workspace_invitations wi
    where wi.workspace_id = metadata_workspace::uuid
      and wi.email = lower(new.email)
      and wi.status = 'pending'
    limit 1;
  end if;

  if invited_workspace_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (invited_workspace_id, new.id, invited_role)
    on conflict (workspace_id, user_id) do update set role = excluded.role;

    update public.workspace_invitations
    set status = 'accepted', accepted_at = now()
    where workspace_id = invited_workspace_id and email = lower(new.email);
  else
    insert into public.workspaces (name, created_by)
    values (profile_name || ' Studio', new.id)
    returning id into new_workspace_id;

    insert into public.workspace_members (workspace_id, user_id, role)
    values (new_workspace_id, new.id, 'owner');
  end if;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Workspace users may invite collaborators, but cannot promote or remove accounts.
-- Membership changes are performed only by trusted backend functions.

drop policy if exists "Owners add memberships" on public.workspace_members;
drop policy if exists "Owners update memberships" on public.workspace_members;
drop policy if exists "Owners remove memberships" on public.workspace_members;

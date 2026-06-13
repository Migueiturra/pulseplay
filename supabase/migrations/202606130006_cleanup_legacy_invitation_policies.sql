-- Remove legacy owner-only rules superseded by fixed-role member invitations.

drop policy if exists "Owners create invitations" on public.workspace_invitations;
drop policy if exists "Owners update invitations" on public.workspace_invitations;

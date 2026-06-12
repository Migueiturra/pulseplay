-- Supabase grants new public functions to API roles by default.
-- Keep only the intentionally public participation endpoints anonymous.

revoke execute on function public.pulseplay_create_live_session(uuid) from anon;
revoke execute on function public.pulseplay_control_live_session(uuid, text, uuid) from anon;
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.set_updated_at() from anon, authenticated;
revoke execute on function public.is_workspace_member(uuid) from anon;
revoke execute on function public.can_edit_workspace(uuid) from anon;
revoke execute on function public.is_workspace_owner(uuid) from anon;

alter function public.set_updated_at() set search_path = public;

-- PulsePlay initial database schema.
-- Authentication is handled by Supabase Auth; passwords never live here.

create extension if not exists pgcrypto;

create type public.workspace_role as enum ('owner', 'editor');
create type public.activity_status as enum ('draft', 'published', 'archived');
create type public.question_type as enum ('quiz', 'poll', 'wordcloud', 'openended', 'scale', 'ranking');
create type public.live_session_status as enum ('lobby', 'question', 'results', 'leaderboard', 'finished');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.workspace_role not null default 'editor',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  title text not null default 'Nueva actividad' check (char_length(title) between 1 and 160),
  description text not null default '' check (char_length(description) <= 500),
  status public.activity_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  type public.question_type not null,
  position integer not null check (position >= 0),
  title text not null check (char_length(title) between 1 and 500),
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  correct_option integer,
  duration_seconds integer check (duration_seconds is null or duration_seconds between 5 and 600),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (activity_id, position),
  check (type = 'quiz' or correct_option is null)
);

create table public.live_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  host_id uuid not null references public.profiles(id),
  code text not null unique check (code ~ '^[0-9]{4,8}$'),
  status public.live_session_status not null default 'lobby',
  current_question_id uuid references public.questions(id) on delete set null,
  reveal_results boolean not null default false,
  question_started_at timestamptz,
  question_ends_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  client_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 40),
  score integer not null default 0 check (score >= 0),
  is_blocked boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (session_id, client_id)
);

create table public.responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  is_correct boolean,
  points integer not null default 0 check (points >= 0),
  response_time_ms integer check (response_time_ms is null or response_time_ms >= 0),
  submitted_at timestamptz not null default now(),
  unique (question_id, participant_id)
);

create index activities_workspace_updated_idx on public.activities (workspace_id, updated_at desc);
create index questions_activity_position_idx on public.questions (activity_id, position);
create index sessions_workspace_created_idx on public.live_sessions (workspace_id, created_at desc);
create index participants_session_score_idx on public.participants (session_id, score desc);
create index responses_session_question_idx on public.responses (session_id, question_id);

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger workspaces_set_updated_at before update on public.workspaces
for each row execute function public.set_updated_at();
create trigger activities_set_updated_at before update on public.activities
for each row execute function public.set_updated_at();
create trigger questions_set_updated_at before update on public.questions
for each row execute function public.set_updated_at();
create trigger sessions_set_updated_at before update on public.live_sessions
for each row execute function public.set_updated_at();

create function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id and user_id = auth.uid()
  );
$$;

create function public.can_edit_workspace(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
      and role in ('owner', 'editor')
  );
$$;

create function public.is_workspace_owner(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
      and role = 'owner'
  );
$$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
  profile_name text;
begin
  profile_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1));

  insert into public.profiles (id, name)
  values (new.id, profile_name);

  insert into public.workspaces (name, created_by)
  values (profile_name || ' Studio', new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.activities enable row level security;
alter table public.questions enable row level security;
alter table public.live_sessions enable row level security;
alter table public.participants enable row level security;
alter table public.responses enable row level security;

create policy "Profiles are visible to their owner"
on public.profiles for select to authenticated
using (id = auth.uid());
create policy "Users update their profile"
on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

create policy "Members read workspaces"
on public.workspaces for select to authenticated
using (public.is_workspace_member(id));
create policy "Owners update workspaces"
on public.workspaces for update to authenticated
using (public.is_workspace_owner(id)) with check (public.is_workspace_owner(id));

create policy "Members read memberships"
on public.workspace_members for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy "Owners add memberships"
on public.workspace_members for insert to authenticated
with check (public.is_workspace_owner(workspace_id));
create policy "Owners update memberships"
on public.workspace_members for update to authenticated
using (public.is_workspace_owner(workspace_id)) with check (public.is_workspace_owner(workspace_id));
create policy "Owners remove memberships"
on public.workspace_members for delete to authenticated
using (public.is_workspace_owner(workspace_id) and user_id <> auth.uid());

create policy "Members read activities"
on public.activities for select to authenticated
using (public.is_workspace_member(workspace_id));
create policy "Editors create activities"
on public.activities for insert to authenticated
with check (public.can_edit_workspace(workspace_id) and created_by = auth.uid());
create policy "Editors update activities"
on public.activities for update to authenticated
using (public.can_edit_workspace(workspace_id)) with check (public.can_edit_workspace(workspace_id));
create policy "Editors delete activities"
on public.activities for delete to authenticated
using (public.can_edit_workspace(workspace_id));

create policy "Members read questions"
on public.questions for select to authenticated
using (exists (
  select 1 from public.activities a
  where a.id = activity_id and public.is_workspace_member(a.workspace_id)
));
create policy "Editors create questions"
on public.questions for insert to authenticated
with check (exists (
  select 1 from public.activities a
  where a.id = activity_id and public.can_edit_workspace(a.workspace_id)
));
create policy "Editors update questions"
on public.questions for update to authenticated
using (exists (
  select 1 from public.activities a
  where a.id = activity_id and public.can_edit_workspace(a.workspace_id)
));
create policy "Editors delete questions"
on public.questions for delete to authenticated
using (exists (
  select 1 from public.activities a
  where a.id = activity_id and public.can_edit_workspace(a.workspace_id)
));

create policy "Members manage live sessions"
on public.live_sessions for all to authenticated
using (public.can_edit_workspace(workspace_id))
with check (public.can_edit_workspace(workspace_id) and host_id = auth.uid());

create policy "Members read participants"
on public.participants for select to authenticated
using (exists (
  select 1 from public.live_sessions s
  where s.id = session_id and public.is_workspace_member(s.workspace_id)
));
create policy "Members update participants"
on public.participants for update to authenticated
using (exists (
  select 1 from public.live_sessions s
  where s.id = session_id and public.can_edit_workspace(s.workspace_id)
));

create policy "Members read responses"
on public.responses for select to authenticated
using (exists (
  select 1 from public.live_sessions s
  where s.id = session_id and public.is_workspace_member(s.workspace_id)
));

-- Public participation will use narrow security-definer RPCs in the next
-- migration. We intentionally do not expose questions.correct_option or raw
-- response tables to anonymous clients.

alter publication supabase_realtime add table public.live_sessions;
alter publication supabase_realtime add table public.participants;
alter publication supabase_realtime add table public.responses;

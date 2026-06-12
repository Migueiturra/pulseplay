-- Secure public API for cross-device live sessions.

alter table public.live_sessions drop constraint if exists live_sessions_code_key;
create unique index if not exists live_sessions_active_code_idx
on public.live_sessions (code)
where status <> 'finished';

create or replace function public.pulseplay_live_state(
  p_code text,
  p_client_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session public.live_sessions%rowtype;
  is_host boolean := false;
  participant_row public.participants%rowtype;
  question_index integer := 0;
  question_count integer := 0;
  result jsonb;
begin
  select * into target_session
  from public.live_sessions
  where code = trim(p_code)
  order by created_at desc
  limit 1;

  if target_session.id is null then
    return null;
  end if;

  is_host := auth.uid() is not null and auth.uid() = target_session.host_id;
  if p_client_id is not null then
    select * into participant_row
    from public.participants
    where session_id = target_session.id and client_id = p_client_id;
  end if;

  select count(*)::integer into question_count
  from public.questions where activity_id = target_session.activity_id;

  if target_session.current_question_id is not null then
    select position into question_index
    from public.questions where id = target_session.current_question_id;
  end if;

  select jsonb_build_object(
    'id', target_session.id,
    'code', target_session.code,
    'activityId', target_session.activity_id,
    'activityTitle', a.title,
    'status', target_session.status,
    'index', coalesce(question_index, 0),
    'reveal', target_session.reveal_results,
    'startedAt', case when target_session.question_started_at is null then null else extract(epoch from target_session.question_started_at) * 1000 end,
    'endsAt', case when target_session.question_ends_at is null then null else extract(epoch from target_session.question_ends_at) * 1000 end,
    'questionCount', question_count,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.display_name,
        'score', p.score,
        'isBlocked', p.is_blocked
      ) order by p.joined_at)
      from public.participants p
      where p.session_id = target_session.id and not p.is_blocked
    ), '[]'::jsonb),
    'blockedParticipants', coalesce((
      select jsonb_agg(p.id)
      from public.participants p
      where p.session_id = target_session.id and p.is_blocked
    ), '[]'::jsonb),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'type', q.type,
        'title', q.title,
        'options', q.options,
        'correct', case when is_host or target_session.status = 'finished' or (target_session.status in ('results', 'leaderboard') and q.position <= question_index) then q.correct_option else null end,
        'duration', coalesce(q.duration_seconds, 0),
        'scaleMax', coalesce((q.settings ->> 'scaleMax')::integer, 5),
        'minLabel', coalesce(q.settings ->> 'minLabel', 'Nada'),
        'maxLabel', coalesce(q.settings ->> 'maxLabel', 'Mucho')
      ) order by q.position)
      from public.questions q where q.activity_id = target_session.activity_id
    ), '[]'::jsonb),
    'answers', case when is_host or target_session.status in ('results', 'leaderboard', 'finished') then coalesce((
      select jsonb_object_agg(
        q.position::text || ':' || r.participant_id::text,
        r.payload || jsonb_build_object('correct', r.is_correct, 'points', r.points)
      )
      from public.responses r
      join public.questions q on q.id = r.question_id
      where r.session_id = target_session.id
    ), '{}'::jsonb) else coalesce((
      select jsonb_object_agg(
        q.position::text || ':' || r.participant_id::text,
        r.payload || jsonb_build_object('correct', r.is_correct, 'points', r.points)
      )
      from public.responses r
      join public.questions q on q.id = r.question_id
      where r.session_id = target_session.id and r.participant_id = participant_row.id
    ), '{}'::jsonb) end,
    'words', case when is_host or target_session.status <> 'question' then coalesce((
      select jsonb_agg(jsonb_build_object('word', r.payload ->> 'word', 'playerId', r.participant_id))
      from public.responses r
      join public.questions q on q.id = r.question_id
      where r.session_id = target_session.id and q.type = 'wordcloud'
    ), '[]'::jsonb) else '[]'::jsonb end,
    'player', case when participant_row.id is null then null else jsonb_build_object(
      'id', participant_row.id,
      'clientId', participant_row.client_id,
      'name', participant_row.display_name,
      'score', participant_row.score,
      'isBlocked', participant_row.is_blocked
    ) end
  ) into result
  from public.activities a where a.id = target_session.activity_id;

  return result;
end;
$$;

create or replace function public.pulseplay_create_live_session(p_activity_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_activity public.activities%rowtype;
  new_session public.live_sessions%rowtype;
  generated_code text;
  attempts integer := 0;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesión'; end if;

  select * into target_activity from public.activities where id = p_activity_id;
  if target_activity.id is null or not public.can_edit_workspace(target_activity.workspace_id) then
    raise exception 'No tienes acceso a esta actividad';
  end if;

  update public.live_sessions
  set status = 'finished', ended_at = now()
  where host_id = auth.uid() and status <> 'finished';

  loop
    attempts := attempts + 1;
    generated_code := lpad((floor(random() * 10000))::integer::text, 4, '0');
    begin
      insert into public.live_sessions (workspace_id, activity_id, host_id, code)
      values (target_activity.workspace_id, target_activity.id, auth.uid(), generated_code)
      returning * into new_session;
      exit;
    exception when unique_violation then
      if attempts >= 30 then raise exception 'No se pudo generar un código disponible'; end if;
    end;
  end loop;

  return public.pulseplay_live_state(new_session.code, null);
end;
$$;

create or replace function public.pulseplay_join_live_session(
  p_code text,
  p_client_id uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session public.live_sessions%rowtype;
  existing_participant public.participants%rowtype;
begin
  select * into target_session from public.live_sessions
  where code = trim(p_code) and status <> 'finished'
  order by created_at desc limit 1;

  if target_session.id is null then raise exception 'Código de sala incorrecto'; end if;
  if char_length(trim(p_display_name)) not between 1 and 40 then raise exception 'Nombre inválido'; end if;

  select * into existing_participant from public.participants
  where session_id = target_session.id and client_id = p_client_id;
  if existing_participant.is_blocked then raise exception 'No puedes volver a entrar a esta sala'; end if;

  insert into public.participants (session_id, client_id, display_name)
  values (target_session.id, p_client_id, trim(p_display_name))
  on conflict (session_id, client_id) do update
  set display_name = excluded.display_name, last_seen_at = now();

  return public.pulseplay_live_state(target_session.code, p_client_id);
end;
$$;

create or replace function public.pulseplay_submit_response(
  p_code text,
  p_client_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session public.live_sessions%rowtype;
  target_question public.questions%rowtype;
  target_participant public.participants%rowtype;
  response_id uuid;
  answer_correct boolean := null;
  awarded_points integer := 0;
  elapsed_ms integer := 0;
begin
  select * into target_session from public.live_sessions
  where code = trim(p_code) and status = 'question'
  order by created_at desc limit 1;
  if target_session.id is null then raise exception 'La pregunta ya está cerrada'; end if;
  if target_session.question_ends_at is not null and now() >= target_session.question_ends_at then raise exception 'Se terminó el tiempo'; end if;

  select * into target_question from public.questions where id = target_session.current_question_id;
  select * into target_participant from public.participants
  where session_id = target_session.id and client_id = p_client_id and not is_blocked;
  if target_participant.id is null then raise exception 'Participante no válido'; end if;

  if target_question.type in ('quiz', 'poll') then
    if not (p_payload ? 'option') then raise exception 'Falta seleccionar una opción'; end if;
    if target_question.type = 'quiz' then
      answer_correct := (p_payload ->> 'option')::integer = target_question.correct_option;
      if answer_correct then
        elapsed_ms := greatest(0, (extract(epoch from (now() - target_session.question_started_at)) * 1000)::integer);
        awarded_points := 500 + case when target_question.duration_seconds is null then 0 else greatest(0, round(500 * (1 - elapsed_ms::numeric / (target_question.duration_seconds * 1000)))::integer) end;
      end if;
    end if;
  elsif target_question.type = 'wordcloud' then
    if char_length(trim(p_payload ->> 'word')) not between 1 and 40 then raise exception 'Palabra inválida'; end if;
  elsif target_question.type = 'openended' then
    if char_length(trim(p_payload ->> 'text')) not between 1 and 280 then raise exception 'Respuesta inválida'; end if;
  elsif target_question.type = 'scale' then
    if not (p_payload ? 'value') then raise exception 'Falta seleccionar un valor'; end if;
  elsif target_question.type = 'ranking' then
    if jsonb_typeof(p_payload -> 'ranking') <> 'array' then raise exception 'Ranking inválido'; end if;
  end if;

  insert into public.responses (session_id, question_id, participant_id, payload, is_correct, points, response_time_ms)
  values (target_session.id, target_question.id, target_participant.id, p_payload, answer_correct, awarded_points, elapsed_ms)
  on conflict (question_id, participant_id) do nothing
  returning id into response_id;

  if response_id is not null and awarded_points > 0 then
    update public.participants set score = score + awarded_points, last_seen_at = now()
    where id = target_participant.id;
  end if;

  return public.pulseplay_live_state(target_session.code, p_client_id);
end;
$$;

create or replace function public.pulseplay_control_live_session(
  p_session_id uuid,
  p_action text,
  p_participant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_session public.live_sessions%rowtype;
  next_question public.questions%rowtype;
  current_position integer := -1;
begin
  select * into target_session from public.live_sessions where id = p_session_id;
  if target_session.id is null or target_session.host_id <> auth.uid() then raise exception 'No tienes acceso a esta sesión'; end if;

  if p_action = 'kick' then
    update public.participants set is_blocked = true where id = p_participant_id and session_id = target_session.id;
  elsif p_action = 'next' then
    if target_session.status = 'lobby' then
      select * into next_question from public.questions where activity_id = target_session.activity_id order by position limit 1;
      if next_question.id is null then raise exception 'La actividad no tiene preguntas'; end if;
      update public.live_sessions set status = 'question', current_question_id = next_question.id,
        reveal_results = false, started_at = coalesce(started_at, now()), question_started_at = now(),
        question_ends_at = case when next_question.duration_seconds is null then null else now() + make_interval(secs => next_question.duration_seconds) end
      where id = target_session.id;
    elsif target_session.status = 'question' then
      update public.live_sessions set status = 'results', reveal_results = true, question_ends_at = null where id = target_session.id;
    elsif target_session.status = 'results' then
      update public.live_sessions set status = 'leaderboard' where id = target_session.id;
    elsif target_session.status = 'leaderboard' then
      select position into current_position from public.questions where id = target_session.current_question_id;
      select * into next_question from public.questions where activity_id = target_session.activity_id and position > current_position order by position limit 1;
      if next_question.id is null then
        update public.live_sessions set status = 'finished', ended_at = now(), question_ends_at = null where id = target_session.id;
      else
        update public.live_sessions set status = 'question', current_question_id = next_question.id,
          reveal_results = false, question_started_at = now(),
          question_ends_at = case when next_question.duration_seconds is null then null else now() + make_interval(secs => next_question.duration_seconds) end
        where id = target_session.id;
      end if;
    end if;
  elsif p_action = 'finish' then
    update public.live_sessions set status = 'finished', ended_at = now(), question_ends_at = null where id = target_session.id;
  else
    raise exception 'Acción no válida';
  end if;

  select * into target_session from public.live_sessions where id = p_session_id;
  return public.pulseplay_live_state(target_session.code, null);
end;
$$;

revoke all on function public.pulseplay_live_state(text, uuid) from public;
revoke all on function public.pulseplay_create_live_session(uuid) from public;
revoke all on function public.pulseplay_join_live_session(text, uuid, text) from public;
revoke all on function public.pulseplay_submit_response(text, uuid, jsonb) from public;
revoke all on function public.pulseplay_control_live_session(uuid, text, uuid) from public;
revoke execute on function public.pulseplay_create_live_session(uuid) from anon;
revoke execute on function public.pulseplay_control_live_session(uuid, text, uuid) from anon;

grant execute on function public.pulseplay_live_state(text, uuid) to anon, authenticated;
grant execute on function public.pulseplay_create_live_session(uuid) to authenticated;
grant execute on function public.pulseplay_join_live_session(text, uuid, text) to anon, authenticated;
grant execute on function public.pulseplay_submit_response(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.pulseplay_control_live_session(uuid, text, uuid) to authenticated;

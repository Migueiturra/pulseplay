create or replace function public.save_activity_with_questions(
  p_activity_id uuid,
  p_title text,
  p_description text,
  p_status public.activity_status,
  p_questions jsonb
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if jsonb_typeof(p_questions) <> 'array' then
    raise exception 'p_questions must be a JSON array';
  end if;

  update public.activities
  set title = p_title,
      description = coalesce(p_description, ''),
      status = p_status
  where id = p_activity_id;

  if not found then
    raise exception 'Activity not found or access denied';
  end if;

  delete from public.questions where activity_id = p_activity_id;

  insert into public.questions (
    id,
    activity_id,
    type,
    position,
    title,
    options,
    correct_option,
    duration_seconds,
    settings
  )
  select
    (item.value ->> 'id')::uuid,
    p_activity_id,
    (item.value ->> 'type')::public.question_type,
    item.ordinality::integer - 1,
    item.value ->> 'title',
    coalesce(item.value -> 'options', '[]'::jsonb),
    case
      when item.value ->> 'type' = 'quiz' then (item.value ->> 'correct_option')::integer
      else null
    end,
    (item.value ->> 'duration_seconds')::integer,
    coalesce(item.value -> 'settings', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as item(value, ordinality);
end;
$$;

revoke all on function public.save_activity_with_questions(uuid, text, text, public.activity_status, jsonb) from public;
grant execute on function public.save_activity_with_questions(uuid, text, text, public.activity_status, jsonb) to authenticated;

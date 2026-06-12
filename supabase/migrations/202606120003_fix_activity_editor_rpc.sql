do $$
declare
  function_record record;
begin
  for function_record in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'save_activity_with_questions'
  loop
    execute format('drop function %s', function_record.signature);
  end loop;
end;
$$;

create function public.save_activity_with_questions(
  p_activity_id uuid,
  p_title text,
  p_description text,
  p_status public.activity_status,
  p_questions jsonb
)
returns void
language plpgsql
security invoker
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
    (entry.value ->> 'id')::uuid,
    p_activity_id,
    (entry.value ->> 'type')::public.question_type,
    entry.ordinality::integer - 1,
    entry.value ->> 'title',
    coalesce(entry.value -> 'options', '[]'::jsonb),
    case
      when entry.value ->> 'type' = 'quiz' then (entry.value ->> 'correct_option')::integer
      else null
    end,
    nullif(entry.value ->> 'duration_seconds', '')::integer,
    coalesce(entry.value -> 'settings', '{}'::jsonb)
  from jsonb_array_elements(p_questions) with ordinality as entry(value, ordinality);
end;
$$;

revoke all on function public.save_activity_with_questions(uuid, text, text, public.activity_status, jsonb) from public;
grant execute on function public.save_activity_with_questions(uuid, text, text, public.activity_status, jsonb) to authenticated;

notify pgrst, 'reload schema';

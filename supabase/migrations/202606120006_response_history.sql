alter table public.responses
  add column if not exists question_title text,
  add column if not exists question_type public.question_type,
  add column if not exists question_options jsonb not null default '[]'::jsonb;

update public.responses r
set question_title = q.title,
    question_type = q.type,
    question_options = q.options
from public.questions q
where q.id = r.question_id
  and (r.question_title is null or r.question_type is null);

alter table public.responses alter column question_id drop not null;
alter table public.responses drop constraint if exists responses_question_id_fkey;
alter table public.responses
  add constraint responses_question_id_fkey
  foreign key (question_id) references public.questions(id) on delete set null;

create or replace function public.snapshot_response_question()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  source_question public.questions%rowtype;
begin
  if new.question_id is not null then
    select * into source_question from public.questions where id = new.question_id;
    new.question_title := source_question.title;
    new.question_type := source_question.type;
    new.question_options := coalesce(source_question.options, '[]'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists responses_snapshot_question on public.responses;
create trigger responses_snapshot_question
before insert or update of question_id on public.responses
for each row execute function public.snapshot_response_question();

revoke all on function public.snapshot_response_question() from public, anon, authenticated;


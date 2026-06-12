# Supabase setup

The first migration defines the PulsePlay data model and its Row Level Security
policies. Supabase Auth owns credentials; the application must never store or
query user passwords.

## Apply the migration

Use the Supabase dashboard SQL editor or the Supabase CLI to apply:

`supabase/migrations/202606120001_initial_schema.sql`

The migration creates:

- profiles and workspaces
- owner/editor memberships
- activities and ordered questions
- live sessions and room codes
- participants, responses and scores
- automatic profile/workspace creation after registration
- RLS policies for all private administration data
- Realtime publication for live-session tables

Anonymous participation is intentionally not opened with broad table policies.
It will be implemented through limited database functions so participants cannot
read `correct_option` before answers are revealed.

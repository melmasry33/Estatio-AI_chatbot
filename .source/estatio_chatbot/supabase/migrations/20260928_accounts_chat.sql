-- Run this migration against the ACCOUNTS Supabase project only.
-- User identity remains in Supabase Auth; this table stores assistant history.

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  property_ids bigint[] not null default array[]::bigint[],
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_session_id
  on public.chat_messages (session_id, created_at desc);

alter table public.chat_messages enable row level security;

grant all on public.chat_messages to service_role;
revoke all on public.chat_messages from anon, authenticated;

-- The chatbot uses the server-only service role key. No browser role can read
-- or write chat history directly.

alter table public.chat_messages
  add column if not exists filters jsonb not null default '{}'::jsonb;

alter table public.chat_messages
  alter column property_ids set default array[]::bigint[];

update public.chat_messages
set filters = '{}'::jsonb
where filters is null;

alter table public.chat_messages
  alter column filters set not null;

-- Keep migrations safe when an older table was created without this constraint.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_role_check'
  ) then
    alter table public.chat_messages
      add constraint chat_messages_role_check
      check (role in ('user', 'assistant'));
  end if;
end
$$;

-- Remove the duplicate chat table from the property project manually if the
-- old assistant migration was already applied there; this file is for the
-- accounts project and must not be run against the property project.
-- Materialized views and property RPCs stay in the property Supabase project.

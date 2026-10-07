-- Enable pgvector extension for vector embeddings
create extension if not exists vector;

-- Ensure properties table supports 1024-dimensional embeddings (nvidia/nemotron-3-embed-1b truncated)
alter table if exists public.properties
  add column if not exists embedding vector(1024);

-- Chat messages history table with session_id index
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  property_ids bigint[] not null default array[]::bigint[],
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Index on session_id for rapid retrieval of conversation context
create index if not exists idx_chat_messages_session_id
  on public.chat_messages (session_id, created_at desc);

-- Grant appropriate permissions
grant select, insert on public.chat_messages to authenticated, anon;
grant all on public.chat_messages to service_role;

-- 5. Hybrid search RPC (structured filters + vector rank)
create or replace function match_properties(
  query_embedding vector(1024),
  p_city text default null,
  p_budget numeric default null,
  p_type text default null,
  p_rooms int default null,
  match_count int default 10
)
returns table (
  property_id bigint,
  city text,
  price_egp numeric,
  property_type text,
  rooms int,
  neighbourhood text,
  representative_title text,
  description text,
  similarity float
)
language sql stable
as $$
  select
    p.property_id,
    p.city,
    p.price_egp,
    p.property_type,
    p.rooms,
    p.neighbourhood,
    p.representative_title,
    coalesce(p.representative_title, '') as description,
    case
      when p.embedding is not null then (1 - (p.embedding <=> query_embedding))
      else 0.5
    end as similarity
  from public.properties p
  where (p_city is null or p.city ilike '%' || p_city || '%' or p.neighbourhood ilike '%' || p_city || '%')
    and (p_budget is null or p.price_egp <= p_budget)
    and (p_type is null or p.property_type ilike '%' || p_type || '%')
    and (p_rooms is null or p.rooms >= p_rooms)
  order by
    case when p.embedding is not null then (p.embedding <=> query_embedding) else null end nulls last,
    p.price_egp asc
  limit match_count;
$$;

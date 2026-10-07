-- Run this against the PROPERTY Supabase project (efounder).
--
-- The previous migration (20260927_init_assistant.sql) documented a design
-- that was never what went live: an `embedding vector(1024)` column directly
-- on `properties`, with `match_properties` reading from it, and a
-- `chat_messages` table with public `anon`/`authenticated` grants.
--
-- What's actually live today:
--   - embeddings are in a dedicated `property_vectors` table
--     (property_id, document_text, embedding halfvec(1024), embedded_at, dedup_key)
--   - `match_properties` joins property_vectors -> property_features
--   - chat_messages lives in the SEPARATE accounts Supabase project only,
--     locked to service_role (see 20260928_accounts_chat.sql there)
--
-- This migration file replaces 20260927_init_assistant.sql so that a fresh
-- environment (or disaster recovery) reproduces the real schema instead of
-- the stale one. Do not re-run 20260927_init_assistant.sql — delete it.

create extension if not exists vector with schema extensions;

-- property_vectors is created by the Python pipeline (src/vector/store.py)
-- via SQLAlchemy — this is a safety net for fresh environments only.
create table if not exists public.property_vectors (
  property_id integer primary key,
  document_text text not null,
  embedding halfvec(1024) not null,
  embedded_at timestamptz not null,
  dedup_key text
);

create index if not exists idx_property_vectors_ivfflat
  on public.property_vectors using ivfflat (embedding halfvec_cosine_ops) with (lists = 100);

alter table public.property_vectors enable row level security;

drop policy if exists property_vectors_public_read on public.property_vectors;
create policy property_vectors_public_read on public.property_vectors
  for select to anon, authenticated using (true);

-- Hybrid search RPC: structured filters are hard constraints (SQL WHERE),
-- vector distance ranks within them. query_embedding arrives as a plain
-- `vector` (1024 floats) from the app and is cast to halfvec for comparison.
create or replace function public.match_properties(
  query_embedding vector,
  p_city text default null,
  p_budget numeric default null,
  p_type text default null,
  p_rooms numeric default null,
  match_count integer default 6
)
returns table (
  property_id integer,
  city character varying,
  neighbourhood character varying,
  property_type character varying,
  rooms double precision,
  baths double precision,
  area_m2 double precision,
  price_egp double precision,
  price_per_m2 double precision,
  representative_title character varying,
  url character varying,
  description text,
  similarity double precision
)
language sql stable
set search_path = public, extensions
as $$
  with vector_candidates as (
    select
      pv.property_id,
      pv.document_text,
      (pv.embedding <=> query_embedding::halfvec(1024)) as distance
    from public.property_vectors pv
    order by pv.embedding <=> query_embedding::halfvec(1024) asc
    limit 100
  )
  select
    pf.property_id,
    pf.city,
    pf.neighbourhood,
    pf.property_type,
    pf.rooms,
    pf.baths,
    pf.area_m2,
    pf.price_egp,
    pf.price_per_m2,
    pf.representative_title,
    pf.url,
    coalesce(vc.document_text, pf.representative_title, '') as description,
    (1 - vc.distance)::float as similarity
  from vector_candidates vc
  join public.property_features pf on pf.property_id = vc.property_id
  where (p_city is null or pf.city ilike '%' || p_city || '%' or pf.neighbourhood ilike '%' || p_city || '%')
    and (p_budget is null or pf.price_egp <= p_budget)
    and (p_type is null or pf.property_type ilike '%' || p_type || '%')
    and (p_rooms is null or pf.rooms >= p_rooms)
  order by vc.distance asc
  limit match_count;
$$;

-- Backend-only pipeline tables: RLS on, no anon/authenticated policy.
alter table if exists public.bronze_listings enable row level security;
alter table if exists public.silver_listings enable row level security;
alter table if exists public.buildings enable row level security;
alter table if exists public.pipeline_runs enable row level security;
alter table if exists public.alembic_version enable row level security;

-- There is NO chat_messages table in this project. It lives only in the
-- accounts Supabase project. If a `properties.embedding` column exists from
-- the old design, it is unused dead weight — drop it once confirmed unused:
-- alter table public.properties drop column if exists embedding;

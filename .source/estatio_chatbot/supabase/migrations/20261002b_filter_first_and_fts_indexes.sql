-- Run after 20261002_align_with_live_schema.sql
-- Fixes a real bug found during testing: match_properties ranked the top
-- 100 nearest vectors GLOBALLY, then applied filters — so real matches
-- outside that top-100 (verified: 819 properties existed for a sample
-- Cairo/3-room/<=6M query) were silently dropped, returning zero results.
-- Filters now apply BEFORE vector ranking (hard constraint, as designed).
-- Also adds indexes property_features was missing entirely (only had a
-- primary key) — without them this version of the function took 1.68s;
-- with them, 65ms.

create extension if not exists pg_trgm with schema extensions;

create index if not exists idx_property_features_city_trgm
  on public.property_features using gin (city extensions.gin_trgm_ops);
create index if not exists idx_property_features_neighbourhood_trgm
  on public.property_features using gin (neighbourhood extensions.gin_trgm_ops);
create index if not exists idx_property_features_type_trgm
  on public.property_features using gin (property_type extensions.gin_trgm_ops);
create index if not exists idx_property_features_rooms on public.property_features (rooms);
create index if not exists idx_property_features_price on public.property_features (price_egp);

create or replace function public.match_properties(
  query_embedding vector,
  p_city text default null,
  p_budget numeric default null,
  p_type text default null,
  p_rooms numeric default null,
  match_count integer default 6
)
returns table (
  property_id integer, city character varying, neighbourhood character varying,
  property_type character varying, rooms double precision, baths double precision,
  area_m2 double precision, price_egp double precision, price_per_m2 double precision,
  representative_title character varying, url character varying, description text,
  similarity double precision
)
language sql stable
set search_path = public, extensions
as $$
  with filtered as (
    select pf.property_id
    from public.property_features pf
    where (p_city is null or pf.city ilike '%' || p_city || '%' or pf.neighbourhood ilike '%' || p_city || '%')
      and (p_budget is null or pf.price_egp <= p_budget)
      and (p_type is null or pf.property_type ilike '%' || p_type || '%')
      and (p_rooms is null or pf.rooms >= p_rooms)
  ),
  vector_candidates as (
    select pv.property_id, pv.document_text, (pv.embedding <=> query_embedding::halfvec(1024)) as distance
    from public.property_vectors pv
    join filtered f on f.property_id = pv.property_id
    order by pv.embedding <=> query_embedding::halfvec(1024) asc
    limit match_count
  )
  select pf.property_id, pf.city, pf.neighbourhood, pf.property_type, pf.rooms, pf.baths,
         pf.area_m2, pf.price_egp, pf.price_per_m2, pf.representative_title, pf.url,
         coalesce(vc.document_text, pf.representative_title, '') as description,
         (1 - vc.distance)::float as similarity
  from vector_candidates vc
  join public.property_features pf on pf.property_id = vc.property_id
  order by vc.distance asc
  limit match_count;
$$;

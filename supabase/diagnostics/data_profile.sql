-- Run in the PROPERTY Supabase project (SQL editor). Read-only.
-- Purpose: confirm the real stored values so assistant.nlu.ts (PROPERTY_TYPES / PLACES)
-- matches the data. Several "passing" tests were vacuous because no type/location
-- filter was ever applied (see REVIEW.md), so these values were never exercised.

-- 1. Which property types exist, and how many? (studio returned 0 results in the test run)
select property_type, count(*) from public.property_features group by 1 order by 2 desc;

-- 2. Cities and top neighbourhoods exactly as stored (hamza / ta-marbuta spellings!)
select city, count(*) from public.property_features group by 1 order by 2 desc limit 40;
select city, neighbourhood, count(*) from public.property_features group by 1, 2 order by 3 desc limit 80;

-- 3. 6 أكتوبر returned 0 rows: which spelling is stored?
select city, neighbourhood, count(*) from public.property_features
where city ilike any (array['%اكتوبر%','%أكتوبر%','%october%','%السادس%'])
   or neighbourhood ilike any (array['%اكتوبر%','%أكتوبر%','%october%','%السادس%'])
group by 1, 2 order by 3 desc;

-- 4. Do duplex / penthouse / townhouse / twin house / land exist under some spelling?
select property_type, count(*) from public.property_features
where property_type ilike any (array['%دوبل%','%duplex%','%بنت%','%penthouse%','%تاون%','%توين%','%ارض%','%أرض%','%اراضي%','%أراضي%'])
group by 1;

-- 5. Coverage: listings without a vector can never be returned by match_properties
select (select count(*) from public.property_features) as features,
       (select count(*) from public.property_vectors)  as vectors;

-- 6. Null price/rooms silently excluded by the budget / rooms filters
select count(*) filter (where price_egp is null) as null_price,
       count(*) filter (where rooms is null)     as null_rooms
from public.property_features;

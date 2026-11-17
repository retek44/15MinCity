-- Repeatable migration: geocoding (address / street / POI search with typo tolerance).

-- unaccent() is only STABLE (it depends on search_path); naming the dictionary makes the
-- result fixed, so this wrapper can be IMMUTABLE and used in indexes.
CREATE OR REPLACE FUNCTION search.unaccent_immutable(t text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
    SELECT public.unaccent('public.unaccent'::regdictionary, t)
$$;

-- Lower case, no accents, no punctuation, Hungarian street type abbreviations expanded:
-- 'Andrássy u. 12/B' -> 'andrassy utca 12/b'
CREATE OR REPLACE FUNCTION search.normalize(t text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
    SELECT trim(regexp_replace(
        regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
            regexp_replace(lower(search.unaccent_immutable(t)), '[^a-z0-9/]+', ' ', 'g'),
            '\mu\M', 'utca', 'g'),
            '\mkrt\M', 'korut', 'g'),
            '\msgt\M', 'sugarut', 'g'),
            '\mrkp\M', 'rakpart', 'g'),
            '\mbp\M', 'budapest', 'g'),
        '\s+', ' ', 'g'))
$$;

-- Rebuilds search.place from the osm schema. Runs after every import.
CREATE OR REPLACE FUNCTION search.build_index()
RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    n bigint;
BEGIN
    TRUNCATE search.place;

    -- Addresses (deduplicated: buildings are often tagged on both a node and a way).
    INSERT INTO search.place (kind, label, sublabel, housenumber, norm, geom)
    SELECT DISTINCT ON (street, housenumber, postcode)
           'address',
           street || ' ' || housenumber,
           concat_ws(' ', postcode, coalesce(city, 'Budapest')),
           search.normalize(housenumber),
           search.normalize(street || ' ' || housenumber),
           geom
    FROM osm.addresses
    ORDER BY street, housenumber, postcode, osm_type DESC;

    -- Streets: one entry per street name and postcode, at the centre of its addresses.
    INSERT INTO search.place (kind, label, sublabel, norm, geom)
    SELECT 'street',
           street,
           concat_ws(' ', postcode, 'Budapest'),
           search.normalize(street),
           ST_PointOnSurface(ST_Collect(geom))
    FROM osm.addresses
    GROUP BY street, postcode;

    -- Named POIs. A station is mapped as many platforms and stop positions with the same
    -- name; keep one per name, category and ~500 m grid square.
    INSERT INTO search.place (kind, label, sublabel, category, norm, geom)
    SELECT DISTINCT ON (name, category, ST_SnapToGrid(geom, 0.005))
           'poi', name, category, category, search.normalize(name), geom
    FROM osm.pois
    WHERE name IS NOT NULL
    ORDER BY name, category, ST_SnapToGrid(geom, 0.005), osm_type DESC, osm_id;

    ANALYZE search.place;
    SELECT count(*) INTO n FROM search.place;
    RETURN n;
END
$$;

-- Ranked search:
--   * the query without its house number is compared with the place (trigram word similarity),
--     so 'andrassy ut 60' cannot be won by 'Áchim András utca 60' on the number alone
--   * exact house number +0.3, same number prefix (60 -> 60-62) +0.15
--   * streets win over their own addresses when no number was typed
--   * optional small penalty for distance from the map centre
CREATE OR REPLACE FUNCTION search.search(
    p_query text,
    p_limit integer DEFAULT 10,
    p_lon double precision DEFAULT NULL,
    p_lat double precision DEFAULT NULL)
RETURNS TABLE (kind text, label text, sublabel text, category text, lon double precision,
               lat double precision, score double precision)
LANGUAGE plpgsql STABLE
SET pg_trgm.word_similarity_threshold = 0.45
AS $$
DECLARE
    v_q    text := search.normalize(p_query);
    v_num  text := substring(search.normalize(p_query) FROM '\s(\d+(/?[a-z])?)$');
    v_name text := trim(regexp_replace(search.normalize(p_query), '\s\d+(/?[a-z])?$', ''));
BEGIN
    IF v_q IS NULL OR length(v_q) < 2 THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT p.kind, p.label, p.sublabel, p.category, ST_X(p.geom), ST_Y(p.geom), ranked.score
    FROM search.place p
    CROSS JOIN LATERAL (
        SELECT word_similarity(v_name, p.norm)
             -- whole-string similarity breaks ties towards the exact name
             -- ('Nyugati pályaudvar' before 'Nyugati pályaudvar M (Podmaniczky utca)')
             + 0.2 * similarity(v_q, p.norm)
             + CASE WHEN v_num IS NULL THEN 0
                    WHEN p.housenumber = v_num THEN 0.3
                    WHEN p.housenumber LIKE v_num || '%' THEN 0.15
                    ELSE 0 END
             + CASE WHEN v_num IS NULL AND p.kind = 'street' THEN 0.1 ELSE 0 END
             - CASE WHEN p_lon IS NULL OR p_lat IS NULL THEN 0
                    ELSE least(0.15, ST_Distance(p.geom::geography,
                                                 ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography) / 100000)
               END AS score
    ) ranked
    WHERE v_q <% p.norm
    ORDER BY ranked.score DESC, p.label
    LIMIT least(greatest(p_limit, 1), 50);
END
$$;

-- Nearest address within p_max_m metres.
CREATE OR REPLACE FUNCTION search.reverse(
    p_lon double precision,
    p_lat double precision,
    p_max_m double precision DEFAULT 150)
RETURNS TABLE (label text, sublabel text, lon double precision, lat double precision, distance_m double precision)
LANGUAGE sql STABLE AS $$
    SELECT * FROM (
        SELECT p.label, p.sublabel, ST_X(p.geom), ST_Y(p.geom),
               ST_Distance(p.geom::geography, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography) AS d
        FROM search.place p
        WHERE p.kind = 'address'
        ORDER BY p.geom <-> ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)
        LIMIT 1
    ) nearest
    WHERE nearest.d <= p_max_m
$$;

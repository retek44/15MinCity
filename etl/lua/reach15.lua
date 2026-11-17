-- osm2pgsql flex config: turns an OSM extract into the raw `osm` schema.
--
--   osm.walk_ways  walkable ways, with their node id list (used to build the graph)
--   osm.pois       points of interest, one row per object, mapped to a category
--   osm.addresses  address points for geocoding
--   osm.districts  administrative boundaries

local SRID = 4326

local tables = {}

tables.walk_ways = osm2pgsql.define_table({
    name = 'walk_ways',
    schema = 'osm',
    ids = { type = 'way', id_column = 'way_id' },
    columns = {
        { column = 'highway', type = 'text', not_null = true },
        { column = 'tags', type = 'jsonb' },
        -- Filled with a PostgreSQL array literal, see process_way.
        { column = 'nodes', type = 'text', sql_type = 'int8[]', not_null = true },
        { column = 'geom', type = 'linestring', projection = SRID, not_null = true },
    },
})

tables.pois = osm2pgsql.define_table({
    name = 'pois',
    schema = 'osm',
    ids = { type = 'any', type_column = 'osm_type', id_column = 'osm_id' },
    columns = {
        { column = 'category', type = 'text', not_null = true },
        { column = 'name', type = 'text' },
        { column = 'opening_hours', type = 'text' },
        { column = 'tags', type = 'jsonb' },
        { column = 'geom', type = 'point', projection = SRID, not_null = true },
        -- Only set for areas (parks need their outline, not just a centre point).
        { column = 'area_geom', type = 'multipolygon', projection = SRID },
    },
})

tables.addresses = osm2pgsql.define_table({
    name = 'addresses',
    schema = 'osm',
    ids = { type = 'any', type_column = 'osm_type', id_column = 'osm_id' },
    columns = {
        { column = 'street', type = 'text', not_null = true },
        { column = 'housenumber', type = 'text', not_null = true },
        { column = 'postcode', type = 'text' },
        { column = 'city', type = 'text' },
        { column = 'geom', type = 'point', projection = SRID, not_null = true },
    },
})

tables.districts = osm2pgsql.define_table({
    name = 'districts',
    schema = 'osm',
    ids = { type = 'relation', id_column = 'relation_id' },
    columns = {
        { column = 'name', type = 'text' },
        { column = 'admin_level', type = 'int' },
        { column = 'geom', type = 'multipolygon', projection = SRID, not_null = true },
    },
})

-- ---------------------------------------------------------------------------
-- Walkability
-- ---------------------------------------------------------------------------

local WALK_HIGHWAYS = {
    footway = true, pedestrian = true, path = true, steps = true, corridor = true,
    living_street = true, residential = true, service = true, unclassified = true, road = true,
    tertiary = true, tertiary_link = true, secondary = true, secondary_link = true,
    primary = true, primary_link = true, track = true, cycleway = true, bridleway = true,
}

local ALLOWED = { yes = true, designated = true, permissive = true }

local function is_walkable(tags)
    local highway = tags.highway
    if not highway then
        return false
    end
    if highway == 'motorway' or highway == 'motorway_link' then
        return false
    end
    if tags.foot == 'no' or tags.foot == 'private' then
        return false
    end
    if ALLOWED[tags.foot] then
        return true
    end
    if tags.access == 'no' or tags.access == 'private' then
        return false
    end
    if highway == 'trunk' or highway == 'trunk_link' then
        -- Trunk roads are only walkable along a mapped (non-separate) sidewalk.
        local sidewalk = tags.sidewalk
        return sidewalk ~= nil and sidewalk ~= 'no' and sidewalk ~= 'none' and sidewalk ~= 'separate'
    end
    return WALK_HIGHWAYS[highway] == true
end

-- ---------------------------------------------------------------------------
-- POI categories
-- ---------------------------------------------------------------------------

local GROCERY_SHOPS = { supermarket = true, convenience = true, greengrocer = true, bakery = true }
local FOOD_AMENITIES = { cafe = true, restaurant = true, fast_food = true }
local TRANSIT_RAILWAY = { tram_stop = true, station = true, halt = true, subway_entrance = true }

local function poi_category(tags)
    local amenity = tags.amenity
    if GROCERY_SHOPS[tags.shop] then return 'grocery' end
    if amenity == 'pharmacy' then return 'pharmacy' end
    if amenity == 'doctors' or amenity == 'clinic' then return 'doctor' end
    if amenity == 'school' then return 'school' end
    if amenity == 'kindergarten' then return 'kindergarten' end
    if amenity == 'library' then return 'library' end
    if FOOD_AMENITIES[amenity] then return 'food' end
    if tags.leisure == 'fitness_centre' then return 'gym' end
    if tags.leisure == 'park' then return 'park' end
    if tags.highway == 'bus_stop' or tags.public_transport == 'platform' or TRANSIT_RAILWAY[tags.railway] then
        return 'transit'
    end
    return nil
end

local function insert_poi(object, category, point, area)
    tables.pois:insert({
        category = category,
        name = object.tags.name,
        opening_hours = object.tags.opening_hours,
        tags = object.tags,
        geom = point,
        area_geom = area,
    })
end

local function insert_address(object, point)
    local tags = object.tags
    local street = tags['addr:street'] or tags['addr:place']
    local housenumber = tags['addr:housenumber']
    if not street or not housenumber then
        return
    end
    tables.addresses:insert({
        street = street,
        housenumber = housenumber,
        postcode = tags['addr:postcode'],
        city = tags['addr:city'],
        geom = point,
    })
end

-- ---------------------------------------------------------------------------
-- Callbacks
-- ---------------------------------------------------------------------------

function osm2pgsql.process_node(object)
    local category = poi_category(object.tags)
    if category then
        insert_poi(object, category, object:as_point(), nil)
    end
    if object.tags['addr:housenumber'] then
        insert_address(object, object:as_point())
    end
end

function osm2pgsql.process_way(object)
    local tags = object.tags

    if is_walkable(tags) then
        tables.walk_ways:insert({
            highway = tags.highway,
            tags = tags,
            nodes = '{' .. table.concat(object.nodes, ',') .. '}',
            geom = object:as_linestring(),
        })
    end

    local category = poi_category(tags)
    local has_address = tags['addr:housenumber'] ~= nil
    if not category and not has_address then
        return
    end

    local area = nil
    local point
    if object.is_closed then
        area = object:as_polygon()
        point = area:centroid()
    else
        point = object:as_linestring():centroid()
    end

    if category then
        insert_poi(object, category, point, area)
    end
    if has_address then
        insert_address(object, point)
    end
end

function osm2pgsql.process_relation(object)
    local tags = object.tags

    if tags.boundary == 'administrative' and (tags.admin_level == '8' or tags.admin_level == '9') then
        tables.districts:insert({
            name = tags.name,
            admin_level = tonumber(tags.admin_level),
            geom = object:as_multipolygon(),
        })
        return
    end

    if tags.type == 'multipolygon' then
        local category = poi_category(tags)
        if category then
            local area = object:as_multipolygon()
            insert_poi(object, category, area:centroid(), area)
        end
    end
end

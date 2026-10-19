"""OSM tag rules: who can use a way, in which direction, and how.

Every directed traversal of a way gets one of three modes:

    RIDE  you can legally ride it in this direction
    WALK  you can't ride it this way, but you can push the bike (pavement,
          footpath, the wrong way down a one-way street)
    NONE  not usable at all (motorway, foot=no and no bikes, private)

ATG's whole idea lives in WALK: those segments are where it beats the
normal cycle routers, and the app tells you to hop off for them.
"""

# Road classes, roughly busiest to quietest, then the off-road kinds.
TRUNK, PRIMARY, SECONDARY, TERTIARY, UNCLASSIFIED, RESIDENTIAL, LIVING, SERVICE, TRACK, \
    CYCLEWAY, PATH, FOOTWAY, STEPS = range(13)

CLASS_NAMES = ["trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
               "living_street", "service", "track", "cycleway", "path", "footway", "steps"]

HIGHWAY_CLASS = {
    "trunk": TRUNK, "trunk_link": TRUNK,
    "primary": PRIMARY, "primary_link": PRIMARY,
    "secondary": SECONDARY, "secondary_link": SECONDARY,
    "tertiary": TERTIARY, "tertiary_link": TERTIARY,
    "unclassified": UNCLASSIFIED, "road": UNCLASSIFIED,
    "residential": RESIDENTIAL,
    "living_street": LIVING,
    "service": SERVICE,
    "track": TRACK,
    "cycleway": CYCLEWAY,
    "path": PATH, "bridleway": PATH,
    "footway": FOOTWAY, "pedestrian": FOOTWAY,
    "steps": STEPS,
}

NONE, RIDE, WALK = 0, 1, 2

YES = {"yes", "designated", "permissive", "destination"}
NO = {"no", "private", "use_sidepath_no"}
UNPAVED = {"unpaved", "gravel", "dirt", "ground", "grass", "mud", "sand", "earth",
           "pebblestone", "woodchips", "rock", "stones"}
INFRA_VALUES = {"lane", "track", "share_busway", "separate", "opposite_lane", "opposite_track",
                "shared_lane", "exclusive"}
OPPOSITE = {"opposite", "opposite_lane", "opposite_track", "opposite_share_busway"}


def classify(tags):
    """Return a dict describing the way, or None if it isn't routable.

    `tags` is anything with .get(key) (an osmium TagList or a plain dict).
    """
    hw = tags.get("highway")
    cls = HIGHWAY_CLASS.get(hw)
    if cls is None:
        return None
    if tags.get("area") == "yes" and cls not in (FOOTWAY,):
        return None
    # Pavements and crossings drawn as their own lines: walking against a
    # one-way uses the street itself, and in London these double the network.
    if tags.get("footway") in ("sidewalk", "crossing", "traffic_island"):
        return None
    if hw == "service" and tags.get("service") in ("parking_aisle", "drive-through"):
        pass  # rideable, just not interesting; keep it

    access = tags.get("access")
    bicycle = tags.get("bicycle")
    foot = tags.get("foot")

    # Can you ride it at all (ignoring direction)?
    if cls in (FOOTWAY, STEPS):
        ride = bicycle in YES and cls != STEPS
    elif cls == PATH:
        ride = bicycle in YES or (hw == "bridleway" and bicycle not in NO)
    else:
        ride = True
    if bicycle in NO or bicycle == "dismount":
        ride = False
    if access in NO and bicycle not in YES:
        ride = False

    # Can you walk it (pushing the bike)?
    walk = foot not in NO
    if access in NO and foot not in YES:
        walk = False
    if cls == TRUNK and foot is None and tags.get("sidewalk") in ("no", "none"):
        walk = False

    if not ride and not walk:
        return None

    # Which way may a bike go? +1 forward only, -1 backward only, 0 both.
    oneway = tags.get("oneway")
    junction = tags.get("junction")
    if oneway in ("yes", "1", "true"):
        bike_dir = 1
    elif oneway in ("-1", "reverse"):
        bike_dir = -1
    elif junction in ("roundabout", "circular") and oneway != "no":
        bike_dir = 1
    else:
        bike_dir = 0

    # Legal contraflow for bikes (very common in London).
    if bike_dir != 0:
        ob = tags.get("oneway:bicycle")
        if ob == "no":
            bike_dir = 0
        elif tags.get("cycleway") in OPPOSITE or any(
                tags.get(k) in OPPOSITE for k in ("cycleway:left", "cycleway:right", "cycleway:both")):
            bike_dir = 0
        elif any(tags.get(k) == "-1" for k in ("cycleway:left:oneway", "cycleway:right:oneway")):
            bike_dir = 0
    if tags.get("oneway:bicycle") in ("yes", "1") and bike_dir == 0:
        bike_dir = 1

    def direction(forward):
        allowed = bike_dir == 0 or (bike_dir == 1) == forward
        if ride and allowed:
            return RIDE, False
        if walk:
            # contraflow = we'd ride it if it weren't one-way
            return WALK, bool(ride and not allowed)
        return NONE, False

    fwd_mode, fwd_contra = direction(True)
    bwd_mode, bwd_contra = direction(False)
    if fwd_mode == NONE and bwd_mode == NONE:
        return None

    infra = cls == CYCLEWAY or any(
        tags.get(k) in INFRA_VALUES
        for k in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both"))
    surface = tags.get("surface")
    unpaved = surface in UNPAVED or tags.get("tracktype") in ("grade3", "grade4", "grade5")

    return {
        "cls": cls,
        "fwd_mode": fwd_mode, "bwd_mode": bwd_mode,
        "fwd_contra": fwd_contra, "bwd_contra": bwd_contra,
        "infra": infra,
        "unpaved": unpaved,
        "name": tags.get("name") or tags.get("ref") or "",
    }


# Area tags that make a route "scenic".
GREEN_LEISURE = {"park", "garden", "nature_reserve", "common", "recreation_ground", "village_green"}
GREEN_LANDUSE = {"forest", "meadow", "recreation_ground", "village_green", "grass", "cemetery"}
GREEN_NATURAL = {"wood", "heath", "scrub", "grassland"}


def is_green_area(tags):
    return (tags.get("leisure") in GREEN_LEISURE
            or tags.get("landuse") in GREEN_LANDUSE
            or tags.get("natural") in GREEN_NATURAL)


def is_water_area(tags):
    return tags.get("natural") == "water" or tags.get("waterway") == "riverbank"


def is_water_line(tags):
    return tags.get("waterway") in ("canal", "river")

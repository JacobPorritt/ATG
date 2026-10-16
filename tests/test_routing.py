"""End-to-end tests on a tiny made-up neighbourhood.

        (0,2) ===== Towpath (in the park, by the canal) ===== (4,2)
          |                                                     |
       West St                                               East St
          |                                                     |
        (0,1) ---------------- Parallel Rd ------------------ (4,1)
          |                      |                              |
        (0,0) <=== Oneway St (westbound only) ============== (4,0)

Going east from (0,0) to (4,0): Oneway St is 400 m but the wrong way;
the legal way round is 600 m.
"""
import pytest

from atgroute import tags as T
from atgroute.build import build
from atgroute.router import Graph

LAT0, LON0 = 51.5, -0.05
DLAT = 100 / 110540.0
DLON = 100 / (111320.0 * 0.6225)


def ll(x, y):
    return LAT0 + y * DLAT, LON0 + x * DLON


def fixture_osm():
    nodes = {}
    for x in range(5):
        for y in range(3):
            nodes[1000 + 10 * x + y] = ll(x, y)
    for x in range(5):
        nodes[2000 + x] = ll(x, 2.25)            # canal
    park = [(-0.5, 1.5), (4.5, 1.5), (4.5, 2.8), (-0.5, 2.8)]
    for i, (x, y) in enumerate(park):
        nodes[3000 + i] = ll(x, y)

    def n(x, y):
        return 1000 + 10 * x + y

    ways = [
        (1, [n(4, 0), n(3, 0), n(2, 0), n(1, 0), n(0, 0)],
         {"highway": "residential", "oneway": "yes", "name": "Oneway St"}),
        (2, [n(x, 1) for x in range(5)], {"highway": "residential", "name": "Parallel Rd"}),
        (3, [n(0, y) for y in range(3)], {"highway": "residential", "name": "West St"}),
        (4, [n(4, y) for y in range(3)], {"highway": "residential", "name": "East St"}),
        (5, [n(x, 2) for x in range(5)],
         {"highway": "path", "bicycle": "yes", "surface": "asphalt", "name": "Towpath"}),
        (6, [n(2, 0), n(2, 1)], {"highway": "residential", "name": "Middle St"}),
        (7, [2000 + x for x in range(5)], {"waterway": "canal", "name": "Regent's Canal"}),
        (8, [3000, 3001, 3002, 3003, 3000], {"leisure": "park", "name": "Little Park"}),
    ]
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="test">']
    for nid, (lat, lon) in nodes.items():
        out.append(f'<node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}"/>')
    for wid, refs, tags in ways:
        out.append(f'<way id="{wid}" version="1">')
        out += [f'<nd ref="{r}"/>' for r in refs]
        out += [f'<tag k="{k}" v="{v.replace(chr(39), "&apos;")}"/>' for k, v in tags.items()]
        out.append("</way>")
    out.append("</osm>")
    return "\n".join(out)


@pytest.fixture(scope="module")
def graph(tmp_path_factory):
    d = tmp_path_factory.mktemp("osm")
    src = d / "mini.osm"
    src.write_text(fixture_osm())
    out = d / "graph.npz"
    build(str(src), str(out))
    return Graph(str(out))


def test_tag_rules():
    one = T.classify({"highway": "residential", "oneway": "yes"})
    assert one["fwd_mode"] == T.RIDE and one["bwd_mode"] == T.WALK and one["bwd_contra"]
    legal = T.classify({"highway": "residential", "oneway": "yes", "oneway:bicycle": "no"})
    assert legal["bwd_mode"] == T.RIDE
    foot = T.classify({"highway": "footway"})
    assert foot["fwd_mode"] == T.WALK and not foot["fwd_contra"]
    assert T.classify({"highway": "motorway"}) is None
    assert T.classify({"highway": "footway", "access": "private"}) is None


def test_direct_walks_against_the_one_way(graph):
    a, b = ll(0, 0), ll(4, 0)
    r = graph.routes(*a, *b)
    direct = r["routes"]["direct"]
    assert 380 < direct["distance_m"] < 420
    assert [w["reason"] for w in direct["walk_throughs"]] == ["one-way"]
    assert direct["walk_throughs"][0]["name"] == "Oneway St"
    # the law-abiding route goes round
    assert 580 < r["standard"]["distance_m"] < 620


def test_chill_goes_round_legally(graph):
    chill = graph.routes(*ll(0, 0), *ll(4, 0))["routes"]["chill"]
    assert chill["walk_throughs"] == []
    assert chill["distance_m"] > 550


def test_scenic_takes_the_towpath(graph):
    scenic = graph.routes(*ll(0, 0), *ll(4, 0))["routes"]["scenic"]
    names = {n for leg in scenic["legs"] for n in leg["names"]}
    assert "Towpath" in names
    assert scenic["green_pct"] > 30


def test_out_of_area(graph):
    from atgroute.router import OutOfArea
    with pytest.raises(OutOfArea):
        graph.route(52.5, 0.5, *ll(4, 0), "direct")


def test_api(graph, monkeypatch):
    from fastapi.testclient import TestClient
    import atgroute.app as app_mod
    monkeypatch.setattr(app_mod, "_graph", graph)
    c = TestClient(app_mod.app)
    a, b = ll(0, 0), ll(4, 0)
    res = c.get(f"/api/routes?from={a[0]},{a[1]}&to={b[0]},{b[1]}")
    assert res.status_code == 200
    body = res.json()
    assert set(body["routes"]) == {"direct", "chill", "scenic"}
    assert body["routes"]["direct"]["saved_s"] is not None
    assert c.get("/api/routes?from=nope&to=1,2").status_code == 400

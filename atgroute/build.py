"""Turn an OpenStreetMap extract into ATG's routing graph.

    python -m atgroute.build data/greater-london-latest.osm.pbf data/graph.npz

Two passes over the file:
  1. find the nodes where routable ways meet (these become graph nodes)
  2. cut every routable way into edges between those nodes, keeping the
     geometry, and collect parks / water for the scenic score

The result is a single .npz the server loads at start-up.
"""
import math
import sys
import time
from array import array

import numpy as np
import osmium
import shapely
from shapely import STRtree

from . import tags as T

WATER_BUFFER_M = 35      # how close counts as "by the canal/river"
MIN_GREEN_AREA_M2 = 3000  # ignore grass verges and roundabout centres


class JunctionPass(osmium.SimpleHandler):
    """Count how many routable ways touch each node."""

    def __init__(self):
        super().__init__()
        self.count = {}

    def way(self, w):
        if T.classify(w.tags) is None:
            return
        refs = [n.ref for n in w.nodes]
        if len(refs) < 2:
            return
        c = self.count
        for r in refs:
            c[r] = c.get(r, 0) + 1
        # ends are always graph nodes
        c[refs[0]] = c.get(refs[0], 0) + 2
        c[refs[-1]] = c.get(refs[-1], 0) + 2


class EdgePass(osmium.SimpleHandler):
    def __init__(self, junction_count):
        super().__init__()
        self.jc = junction_count
        self.node_index = {}
        self.node_lon = array("d")
        self.node_lat = array("d")

        self.u = array("i")
        self.v = array("i")
        self.geom_off = array("q")
        self.lon = array("d")
        self.lat = array("d")
        self.attrs = []          # (cls, fwd_mode, bwd_mode, fwd_contra, bwd_contra, infra, unpaved, name_id)
        self.names = [""]
        self.name_ids = {"": 0}

        self.green = []          # shapely polygons in lon/lat
        self.water = []          # shapely polygons or lines in lon/lat
        self.wkb = osmium.geom.WKBFactory()

    def _node(self, ref, loc):
        idx = self.node_index.get(ref)
        if idx is None:
            idx = len(self.node_lon)
            self.node_index[ref] = idx
            self.node_lon.append(loc.lon)
            self.node_lat.append(loc.lat)
        return idx

    def _name_id(self, name):
        i = self.name_ids.get(name)
        if i is None:
            i = len(self.names)
            self.names.append(name)
            self.name_ids[name] = i
        return i

    def way(self, w):
        if T.is_water_line(w.tags):
            try:
                self.water.append(shapely.from_wkb(self.wkb.create_linestring(w)))
            except Exception:
                pass

        info = T.classify(w.tags)
        if info is None:
            return
        name_id = self._name_id(info["name"])
        attrs = (info["cls"], info["fwd_mode"], info["bwd_mode"], info["fwd_contra"],
                 info["bwd_contra"], info["infra"], info["unpaved"], name_id)

        jc = self.jc
        pts = []   # current edge: list of (ref, lon, lat)
        for n in w.nodes:
            loc = n.location
            if not loc.valid():
                # way runs off the edge of the extract: close what we have
                self._emit(pts, attrs)
                pts = []
                continue
            pts.append((n.ref, loc.lon, loc.lat))
            if len(pts) > 1 and jc.get(n.ref, 0) >= 2:
                self._emit(pts, attrs)
                pts = [pts[-1]]
        self._emit(pts, attrs)

    def _emit(self, pts, attrs):
        if len(pts) < 2:
            return
        if pts[0][0] == pts[-1][0] and len(pts) == 2:
            return
        # make sure both ends are graph nodes even if the way was cut
        u = self._node(pts[0][0], _Loc(pts[0][1], pts[0][2]))
        v = self._node(pts[-1][0], _Loc(pts[-1][1], pts[-1][2]))
        self.u.append(u)
        self.v.append(v)
        self.geom_off.append(len(self.lon))
        for _, lon, lat in pts:
            self.lon.append(lon)
            self.lat.append(lat)
        self.attrs.append(attrs)

    def area(self, a):
        green = T.is_green_area(a.tags)
        water = T.is_water_area(a.tags)
        if not (green or water):
            return
        try:
            geom = shapely.from_wkb(self.wkb.create_multipolygon(a))
        except Exception:
            return
        (self.green if green else self.water).append(geom)


class _Loc:
    __slots__ = ("lon", "lat")

    def __init__(self, lon, lat):
        self.lon, self.lat = lon, lat


def project(lon, lat, lat0):
    """Equirectangular projection to metres around lat0. Fine at city scale."""
    k = math.cos(math.radians(lat0))
    return np.asarray(lon) * 111320.0 * k, np.asarray(lat) * 110540.0


def green_scores(e, lat0):
    """Fraction (0..1) of each edge's length that runs through green space or by water."""
    lon = np.frombuffer(e.lon, dtype=np.float64)
    lat = np.frombuffer(e.lat, dtype=np.float64)
    off = np.frombuffer(e.geom_off, dtype=np.int64)
    n_edges = len(off)
    if n_edges == 0:
        return np.zeros(0, dtype=np.float32), np.zeros(0, dtype=np.float32)
    x, y = project(lon, lat, lat0)

    # segment i joins point i and i+1, but not across edge boundaries
    seg_edge = np.repeat(np.arange(n_edges), np.diff(np.append(off, len(lon))))
    same = seg_edge[:-1] == seg_edge[1:]
    i0 = np.nonzero(same)[0]
    mx = (x[i0] + x[i0 + 1]) / 2
    my = (y[i0] + y[i0 + 1]) / 2
    seg_len = np.hypot(x[i0 + 1] - x[i0], y[i0 + 1] - y[i0])
    owner = seg_edge[i0]

    def to_m(geoms):
        k = 111320.0 * math.cos(math.radians(lat0))
        out = []
        for g in geoms:
            g = shapely.transform(g, lambda c: c * np.array([k, 110540.0]))
            if g.is_valid or g.geom_type.startswith("Line"):
                out.append(g)
            else:
                out.append(g.buffer(0))
        return out

    green = [g for g in to_m(e.green) if g.area >= MIN_GREEN_AREA_M2]
    water = to_m(e.water)
    hit = np.zeros(len(i0), dtype=bool)
    if len(i0):
        points = shapely.points(mx, my)
        if green:
            idx = STRtree(green).query(points, predicate="intersects")[0]
            hit[idx] = True
        if water:
            idx = STRtree(water).query(points, predicate="dwithin", distance=WATER_BUFFER_M)[0]
            hit[idx] = True

    total = np.bincount(owner, weights=seg_len, minlength=n_edges)
    good = np.bincount(owner, weights=seg_len * hit, minlength=n_edges)
    with np.errstate(invalid="ignore", divide="ignore"):
        score = np.where(total > 0, good / total, 0.0)
    return score.astype(np.float32), total.astype(np.float32)


def build(pbf, out):
    t0 = time.time()
    jp = JunctionPass()
    jp.apply_file(pbf)
    print(f"pass 1: {len(jp.count):,} nodes on routable ways ({time.time() - t0:.0f}s)")

    ep = EdgePass(jp.count)
    del jp
    ep.apply_file(pbf, locations=True)
    print(f"pass 2: {len(ep.node_lon):,} graph nodes, {len(ep.u):,} edges, "
          f"{len(ep.green):,} green areas, {len(ep.water):,} water features ({time.time() - t0:.0f}s)")

    node_lat = np.frombuffer(ep.node_lat, dtype=np.float64)
    lat0 = float(node_lat.mean()) if len(node_lat) else 51.5
    green, length = green_scores(ep, lat0)

    a = np.array(ep.attrs, dtype=np.int32).reshape(-1, 8)
    np.savez_compressed(
        out,
        lat0=np.float64(lat0),
        node_lon=np.frombuffer(ep.node_lon, dtype=np.float64),
        node_lat=node_lat,
        edge_u=np.frombuffer(ep.u, dtype=np.int32),
        edge_v=np.frombuffer(ep.v, dtype=np.int32),
        edge_len=length,
        edge_cls=a[:, 0].astype(np.uint8),
        edge_fwd_mode=a[:, 1].astype(np.uint8),
        edge_bwd_mode=a[:, 2].astype(np.uint8),
        edge_fwd_contra=a[:, 3].astype(bool),
        edge_bwd_contra=a[:, 4].astype(bool),
        edge_infra=a[:, 5].astype(bool),
        edge_unpaved=a[:, 6].astype(bool),
        edge_name=a[:, 7].astype(np.int32),
        edge_green=green,
        geom_off=np.frombuffer(ep.geom_off, dtype=np.int64),
        geom_lon=np.frombuffer(ep.lon, dtype=np.float64),
        geom_lat=np.frombuffer(ep.lat, dtype=np.float64),
        names=np.array("\x00".join(ep.names)),
    )
    print(f"wrote {out} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python -m atgroute.build INPUT.osm.pbf OUTPUT.npz")
    build(sys.argv[1], sys.argv[2])

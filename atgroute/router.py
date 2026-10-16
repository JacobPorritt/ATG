"""ATG router: A* over the prebuilt graph with three ride styles.

Costs are in "effective metres": a metre of quiet back street costs 1.0,
a metre of busy A-road might cost 2.5 in Chill, a metre along the canal
might cost 0.5 in Scenic. Each profile is a cost per directed arc, worked
out once at start-up.
"""
import heapq
import math

import numpy as np
from scipy.spatial import cKDTree

from . import tags as T

RIDE_MPS = 16 / 3.6     # London average-ish cycling speed
WALK_MPS = 4.5 / 3.6    # pushing a bike
STEPS_MPS = 0.6         # carrying it up steps
JUNCTION_S = 4          # average delay per junction when riding

SNAP_MAX_M = 400


class Profile:
    """How much each kind of metre costs. Edit these to tune the feel."""

    def __init__(self, name, cls_mult, walk_mult, steps_mult, contra_ok=True, walk_ok=True,
                 green_bonus=0.0, infra_relief=0.0, unpaved_mult=1.0, per_edge=0.0):
        self.name = name
        self.cls_mult = cls_mult
        self.walk_mult = walk_mult
        self.steps_mult = steps_mult
        self.contra_ok = contra_ok
        self.walk_ok = walk_ok
        self.green_bonus = green_bonus
        self.infra_relief = infra_relief
        self.unpaved_mult = unpaved_mult
        self.per_edge = per_edge


#           trunk prim  sec   tert  uncl  resi  livi  serv  trck  cycl  path  foot  steps
DIRECT_CLS = [1.10, 1.05, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.05, 1.00, 1.00, 1.00, 1.00]
CHILL_CLS = [3.00, 2.20, 1.70, 1.30, 1.10, 1.00, 0.95, 1.10, 1.15, 0.85, 0.95, 1.00, 1.00]

PROFILES = {
    # As the crow cycles: shortest distance, and walking bits only cost a bit extra.
    "direct": Profile("direct", DIRECT_CLS, walk_mult=1.35, steps_mult=4.0, unpaved_mult=1.2),
    # Quiet streets, few junctions, only hop off when it really pays.
    "chill": Profile("chill", CHILL_CLS, walk_mult=2.0, steps_mult=6.0, infra_relief=0.6,
                     unpaved_mult=1.3, per_edge=15),
    # Canals, parks, green space. Happy to go the long way round.
    "scenic": Profile("scenic", CHILL_CLS, walk_mult=1.5, steps_mult=6.0, infra_relief=0.6,
                      green_bonus=0.6, unpaved_mult=1.1, per_edge=8),
    # What a normal law-abiding cycle router would do. Used for "time saved".
    "standard": Profile("standard", DIRECT_CLS, walk_mult=1.0, steps_mult=1.0,
                        contra_ok=False, walk_ok=False, unpaved_mult=1.2),
}

MODES = ("direct", "chill", "scenic")


class Graph:
    def __init__(self, path):
        d = np.load(path)
        self.lat0 = float(d["lat0"])
        self.node_lon = d["node_lon"]
        self.node_lat = d["node_lat"]
        self.edge_u = d["edge_u"]
        self.edge_v = d["edge_v"]
        self.edge_len = d["edge_len"].astype(np.float64)
        self.edge_cls = d["edge_cls"]
        self.edge_infra = d["edge_infra"]
        self.edge_unpaved = d["edge_unpaved"]
        self.edge_green = d["edge_green"].astype(np.float64)
        self.edge_name = d["edge_name"]
        self.geom_off = d["geom_off"]
        self.geom_lon = d["geom_lon"]
        self.geom_lat = d["geom_lat"]
        self.names = str(d["names"]).split("\x00")
        n_edges = len(self.edge_u)
        self.geom_end = np.append(self.geom_off[1:], len(self.geom_lon))

        # Directed arcs: one per usable direction of each edge.
        fwd_mode, bwd_mode = d["edge_fwd_mode"], d["edge_bwd_mode"]
        fwd_contra, bwd_contra = d["edge_fwd_contra"], d["edge_bwd_contra"]
        eid = np.arange(n_edges)
        f = fwd_mode > 0
        b = bwd_mode > 0
        arc_edge = np.concatenate([eid[f], eid[b]])
        arc_rev = np.concatenate([np.zeros(f.sum(), bool), np.ones(b.sum(), bool)])
        arc_from = np.concatenate([self.edge_u[f], self.edge_v[b]])
        arc_to = np.concatenate([self.edge_v[f], self.edge_u[b]])
        arc_mode = np.concatenate([fwd_mode[f], bwd_mode[b]])
        arc_contra = np.concatenate([fwd_contra[f], bwd_contra[b]])

        order = np.argsort(arc_from, kind="stable")
        self.arc_edge = arc_edge[order]
        self.arc_rev = arc_rev[order]
        self.arc_to = arc_to[order]
        self.arc_mode = arc_mode[order]
        self.arc_contra = arc_contra[order]
        n_nodes = len(self.node_lon)
        self.indptr = np.zeros(n_nodes + 1, dtype=np.int64)
        np.add.at(self.indptr, arc_from[order] + 1, 1)
        self.indptr = np.cumsum(self.indptr)

        # projected coordinates for heuristics and snapping
        self.kx = 111320.0 * math.cos(math.radians(self.lat0))
        self.ky = 110540.0
        self.node_x = (self.node_lon * self.kx).tolist()
        self.node_y = (self.node_lat * self.ky).tolist()
        gx = self.geom_lon * self.kx
        gy = self.geom_lat * self.ky
        self.geom_edge = np.repeat(np.arange(n_edges), self.geom_end - self.geom_off)
        self.tree = cKDTree(np.column_stack([gx, gy])) if len(gx) else None

        self._indptr = self.indptr.tolist()
        self._arc_to = self.arc_to.tolist()
        self.costs = {name: self._arc_costs(p) for name, p in PROFILES.items()}

    # cost per arc, in effective metres; -1 means "can't use this arc"
    def _arc_costs(self, p):
        e = self.arc_edge
        length = self.edge_len[e]
        cls = self.edge_cls[e]
        mult = np.asarray(p.cls_mult)[cls]
        if p.infra_relief:
            infra = self.edge_infra[e]
            mult = np.where(infra & (mult > 1), 1 + (mult - 1) * (1 - p.infra_relief), mult)
        mult = np.where(self.edge_unpaved[e], mult * p.unpaved_mult, mult)
        walking = self.arc_mode == T.WALK
        mult = np.where(walking, p.walk_mult, mult)
        mult = np.where(cls == T.STEPS, p.steps_mult, mult)
        if p.green_bonus:
            mult = mult * (1 - p.green_bonus * self.edge_green[e])
        cost = length * mult + p.per_edge
        if not p.walk_ok:
            cost = np.where(walking, -1.0, cost)
        if not p.contra_ok:
            cost = np.where(self.arc_contra, -1.0, cost)
        usable = cost >= 0
        self_min = float(mult[usable].min()) if usable.any() else 1.0
        return cost.tolist(), max(self_min, 0.05)

    # ------------------------------------------------------------------
    def snap(self, lat, lon):
        """Nearest point on the network: (edge, vertex index, metres away)."""
        dist, i = self.tree.query([lon * self.kx, lat * self.ky])
        return int(self.geom_edge[i]), int(i), float(dist)

    def _edge_coords(self, e):
        s, t = self.geom_off[e], self.geom_end[e]
        return list(zip(self.geom_lon[s:t].tolist(), self.geom_lat[s:t].tolist()))

    def _dir_mode(self, e, forward):
        """Mode used on part of edge e, travelling forward or backward."""
        lo, hi = self.indptr[self.edge_u[e] if forward else self.edge_v[e]], \
            self.indptr[(self.edge_u[e] if forward else self.edge_v[e]) + 1]
        for a in range(lo, hi):
            if self.arc_edge[a] == e and self.arc_rev[a] != forward:
                return int(self.arc_mode[a]), bool(self.arc_contra[a])
        return T.WALK, False

    def route(self, a_lat, a_lon, b_lat, b_lon, profile):
        ea, ia, da = self.snap(a_lat, a_lon)
        eb, ib, db = self.snap(b_lat, b_lon)
        if da > SNAP_MAX_M or db > SNAP_MAX_M:
            raise OutOfArea()
        costs, minmult = self.costs[profile]

        # Start: leave the snapped point towards either end of its edge.
        starts = {}
        start_part = {}
        for node, pts, forward in self._split(ea, ia, leaving=True):
            seg_len = _length(pts, self.kx, self.ky)
            starts[node] = min(starts.get(node, math.inf), seg_len)
            start_part[node] = (pts, ea, forward)
        goals = {}
        goal_part = {}
        for node, pts, forward in self._split(eb, ib, leaving=False):
            seg_len = _length(pts, self.kx, self.ky)
            goals[node] = min(goals.get(node, math.inf), seg_len)
            goal_part[node] = (pts, eb, forward)

        if ea == eb:
            # same edge: just ride along it
            pts = self._between(ea, ia, ib)
            fwd = ib >= ia
            mode, contra = self._dir_mode(ea, fwd)
            return self._assemble([(pts, ea, mode, contra)])

        tx, ty = b_lon * self.kx, b_lat * self.ky
        nx, ny = self.node_x, self.node_y
        indptr, arc_to = self._indptr, self._arc_to
        g = {}
        prev = {}
        heap = []
        for node, d in starts.items():
            g[node] = d
            prev[node] = -1
            heapq.heappush(heap, (d + minmult * math.hypot(nx[node] - tx, ny[node] - ty), d, node))
        best, best_node = math.inf, None
        pops = 0
        while heap:
            f, gn, n = heapq.heappop(heap)
            if f >= best:
                break
            if gn > g.get(n, math.inf):
                continue
            pops += 1
            if pops > 3_000_000:
                break
            if n in goals:
                total = gn + goals[n]
                if total < best:
                    best, best_node = total, n
            for a in range(indptr[n], indptr[n + 1]):
                c = costs[a]
                if c < 0:
                    continue
                m = arc_to[a]
                ng = gn + c
                if ng < g.get(m, math.inf):
                    g[m] = ng
                    prev[m] = a
                    heapq.heappush(heap, (ng + minmult * math.hypot(nx[m] - tx, ny[m] - ty), ng, m))
        if best_node is None:
            raise NoRoute()

        arcs = []
        n = best_node
        while prev[n] != -1:
            a = prev[n]
            arcs.append(a)
            e = int(self.arc_edge[a])
            n = int(self.edge_v[e] if self.arc_rev[a] else self.edge_u[e])
        arcs.reverse()
        first = n

        pieces = []
        pts, e, forward = start_part[first]
        mode, contra = self._dir_mode(e, forward)
        pieces.append((pts, e, mode, contra))
        for a in arcs:
            e = int(self.arc_edge[a])
            pts = self._edge_coords(e)
            if self.arc_rev[a]:
                pts.reverse()
            pieces.append((pts, e, int(self.arc_mode[a]), bool(self.arc_contra[a])))
        pts, e, forward = goal_part[best_node]
        mode, contra = self._dir_mode(e, forward)
        pieces.append((pts, e, mode, contra))
        return self._assemble(pieces)

    def _split(self, e, i, leaving):
        """The two halves of edge e either side of geometry point i."""
        coords = self._edge_coords(e)
        k = i - int(self.geom_off[e])
        u, v = int(self.edge_u[e]), int(self.edge_v[e])
        to_u = coords[:k + 1][::-1]      # point -> u, travelling backward
        to_v = coords[k:]                # point -> v, travelling forward
        if leaving:
            return [(u, to_u, False), (v, to_v, True)]
        # arriving: u -> point is forward, v -> point is backward
        return [(u, to_u[::-1], True), (v, to_v[::-1], False)]

    def _between(self, e, i, j):
        coords = self._edge_coords(e)
        a, b = i - int(self.geom_off[e]), j - int(self.geom_off[e])
        return coords[a:b + 1] if a <= b else coords[b:a + 1][::-1]

    def _assemble(self, pieces):
        """Merge pieces into ride/walk legs and add up the numbers."""
        legs = []
        dist = ride_m = walk_m = green_m = 0.0
        eta = 0.0
        for pts, e, mode, contra in pieces:
            if len(pts) < 2:
                continue
            length = _length(pts, self.kx, self.ky)
            steps = int(self.edge_cls[e]) == T.STEPS
            kind = "walk" if mode == T.WALK or steps else "ride"
            if kind == "walk":
                reason = "steps" if steps else ("one-way" if contra else "footpath")
            else:
                reason = None
            dist += length
            green_m += length * float(self.edge_green[e])
            if kind == "ride":
                ride_m += length
                eta += length / RIDE_MPS + JUNCTION_S
            else:
                walk_m += length
                eta += length / (STEPS_MPS if steps else WALK_MPS)
            name = self.names[int(self.edge_name[e])]
            last = legs[-1] if legs else None
            if last and last["kind"] == kind and last["reason"] == reason:
                last["coords"].extend(pts[1:])
                last["distance_m"] += length
                if name and name not in last["names"]:
                    last["names"].append(name)
            else:
                legs.append({"kind": kind, "reason": reason, "coords": list(pts),
                             "distance_m": length, "names": [name] if name else []})

        # ignore tiny "walk" crumbs under 15 m (snapping noise at the ends)
        walks = [l for l in legs if l["kind"] == "walk" and l["distance_m"] >= 15]
        return {
            "distance_m": round(dist),
            "eta_s": round(eta),
            "ride_m": round(ride_m),
            "walk_m": round(walk_m),
            "green_pct": round(100 * green_m / dist) if dist else 0,
            "walk_throughs": [{"reason": l["reason"], "distance_m": round(l["distance_m"]),
                               "name": l["names"][0] if l["names"] else None} for l in walks],
            "legs": [{"kind": l["kind"], "reason": l["reason"], "distance_m": round(l["distance_m"]),
                      "names": l["names"], "coords": [[round(x, 6), round(y, 6)] for x, y in l["coords"]]}
                     for l in legs],
        }

    def routes(self, a_lat, a_lon, b_lat, b_lon):
        """All three ATG modes plus the standard route for comparison."""
        out = {}
        try:
            std = self.route(a_lat, a_lon, b_lat, b_lon, "standard")
        except NoRoute:
            std = None
        for m in MODES:
            r = self.route(a_lat, a_lon, b_lat, b_lon, m)
            r["saved_s"] = std["eta_s"] - r["eta_s"] if std else None
            out[m] = r
        return {"routes": out, "standard": {k: std[k] for k in ("distance_m", "eta_s")} if std else None}


def _length(pts, kx, ky):
    total = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        total += math.hypot((x1 - x0) * kx, (y1 - y0) * ky)
    return total


class OutOfArea(Exception):
    pass


class NoRoute(Exception):
    pass

// Browser-only version of the ATG router, for testing without a server.
// Downloads the streets around your trip from OpenStreetMap (Overpass API),
// builds a little graph and runs the same three ride styles as the Python
// router (see atgroute/tags.py and atgroute/router.py; keep the numbers in sync).

type LngLat = [number, number];
type Tags = Record<string, string | undefined>;

const NONE = 0, RIDE = 1, WALK = 2;
const TRUNK = 0, PATH = 10, FOOTWAY = 11, STEPS = 12, CYCLEWAY = 9;
const HIGHWAY_CLASS: Record<string, number> = {
  trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2,
  tertiary: 3, tertiary_link: 3, unclassified: 4, road: 4, residential: 5, living_street: 6,
  service: 7, track: 8, cycleway: 9, path: 10, bridleway: 10, footway: 11, pedestrian: 11, steps: 12,
};
const YES = new Set(["yes", "designated", "permissive", "destination"]);
const NO = new Set(["no", "private"]);
const UNPAVED = new Set(["unpaved", "gravel", "dirt", "ground", "grass", "mud", "sand", "earth",
  "pebblestone", "woodchips", "rock", "stones"]);
const INFRA = new Set(["lane", "track", "share_busway", "separate", "opposite_lane", "opposite_track",
  "shared_lane", "exclusive"]);
const OPPOSITE = new Set(["opposite", "opposite_lane", "opposite_track", "opposite_share_busway"]);

interface WayInfo {
  cls: number; fwd: number; bwd: number; fwdContra: boolean; bwdContra: boolean;
  infra: boolean; unpaved: boolean; name: string;
}

function classify(t: Tags): WayInfo | null {
  const hw = t.highway;
  const cls = hw ? HIGHWAY_CLASS[hw] : undefined;
  if (cls === undefined) return null;
  if (t.area === "yes" && cls !== FOOTWAY) return null;
  const { access, bicycle, foot } = t;

  let ride: boolean;
  if (cls === FOOTWAY || cls === STEPS) ride = YES.has(bicycle ?? "") && cls !== STEPS;
  else if (cls === PATH) ride = YES.has(bicycle ?? "") || (hw === "bridleway" && !NO.has(bicycle ?? ""));
  else ride = true;
  if (NO.has(bicycle ?? "") || bicycle === "dismount") ride = false;
  if (NO.has(access ?? "") && !YES.has(bicycle ?? "")) ride = false;

  let walk = !NO.has(foot ?? "");
  if (NO.has(access ?? "") && !YES.has(foot ?? "")) walk = false;
  if (cls === TRUNK && foot === undefined && (t.sidewalk === "no" || t.sidewalk === "none")) walk = false;
  if (!ride && !walk) return null;

  let dir = 0;
  const ow = t.oneway;
  if (ow === "yes" || ow === "1" || ow === "true") dir = 1;
  else if (ow === "-1" || ow === "reverse") dir = -1;
  else if ((t.junction === "roundabout" || t.junction === "circular") && ow !== "no") dir = 1;
  if (dir !== 0) {
    if (t["oneway:bicycle"] === "no") dir = 0;
    else if ([t.cycleway, t["cycleway:left"], t["cycleway:right"], t["cycleway:both"]].some((v) => OPPOSITE.has(v ?? ""))) dir = 0;
    else if (t["cycleway:left:oneway"] === "-1" || t["cycleway:right:oneway"] === "-1") dir = 0;
  }
  if ((t["oneway:bicycle"] === "yes" || t["oneway:bicycle"] === "1") && dir === 0) dir = 1;

  const direction = (forward: boolean): [number, boolean] => {
    const allowed = dir === 0 || (dir === 1) === forward;
    if (ride && allowed) return [RIDE, false];
    if (walk) return [WALK, ride && !allowed];
    return [NONE, false];
  };
  const [fwd, fwdContra] = direction(true);
  const [bwd, bwdContra] = direction(false);
  if (fwd === NONE && bwd === NONE) return null;
  const infra = cls === CYCLEWAY ||
    [t.cycleway, t["cycleway:left"], t["cycleway:right"], t["cycleway:both"]].some((v) => INFRA.has(v ?? ""));
  const unpaved = UNPAVED.has(t.surface ?? "") || ["grade3", "grade4", "grade5"].includes(t.tracktype ?? "");
  return { cls, fwd, bwd, fwdContra, bwdContra, infra, unpaved, name: t.name || t.ref || "" };
}

const GREEN = (t: Tags) =>
  ["park", "garden", "nature_reserve", "common", "recreation_ground", "village_green"].includes(t.leisure ?? "") ||
  ["forest", "meadow", "recreation_ground", "village_green", "grass", "cemetery"].includes(t.landuse ?? "") ||
  ["wood", "heath", "scrub", "grassland"].includes(t.natural ?? "");
const WATER_AREA = (t: Tags) => t.natural === "water" || t.waterway === "riverbank";
const WATER_LINE = (t: Tags) => t.waterway === "canal" || t.waterway === "river";

// ---------------------------------------------------------------- profiles
interface Profile { cls: number[]; walk: number; steps: number; contraOk: boolean; walkOk: boolean;
  green: number; infraRelief: number; unpaved: number; perEdge: number }
const DIRECT_CLS = [1.10, 1.05, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.05, 1.00, 1.00, 1.00, 1.00];
const CHILL_CLS = [3.00, 2.20, 1.70, 1.30, 1.10, 1.00, 0.95, 1.10, 1.15, 0.85, 0.95, 1.00, 1.00];
const PROFILES: Record<string, Profile> = {
  direct: { cls: DIRECT_CLS, walk: 1.35, steps: 4, contraOk: true, walkOk: true, green: 0, infraRelief: 0, unpaved: 1.2, perEdge: 0 },
  chill: { cls: CHILL_CLS, walk: 2.0, steps: 6, contraOk: true, walkOk: true, green: 0, infraRelief: 0.6, unpaved: 1.3, perEdge: 15 },
  scenic: { cls: CHILL_CLS, walk: 1.5, steps: 6, contraOk: true, walkOk: true, green: 0.6, infraRelief: 0.6, unpaved: 1.1, perEdge: 8 },
  standard: { cls: DIRECT_CLS, walk: 1, steps: 1, contraOk: false, walkOk: false, green: 0, infraRelief: 0, unpaved: 1.2, perEdge: 0 },
};
const RIDE_MPS = 16 / 3.6, WALK_MPS = 4.5 / 3.6, STEPS_MPS = 0.6, JUNCTION_S = 4;

// ---------------------------------------------------------------- graph
interface Graph {
  kx: number; ky: number;
  lon: Float64Array; lat: Float64Array;
  // arcs as CSR
  start: Int32Array; to: Int32Array; edge: Int32Array; mode: Uint8Array; contra: Uint8Array;
  eLen: Float64Array; eCls: Uint8Array; eInfra: Uint8Array; eUnpaved: Uint8Array; eGreen: Float32Array; eName: Int32Array;
  edgeEnd: boolean[]; // whether node starts a new "edge" for per-edge cost (junction)
  names: string[];
  bbox: [number, number, number, number];
}

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function overpass(b: [number, number, number, number]) {
  const bb = `${b[1]},${b[0]},${b[3]},${b[2]}`;
  const q = `[out:json][timeout:90];(
way["highway"](${bb});
way["waterway"~"^(canal|river|riverbank)$"](${bb});
way["natural"~"^(water|wood|heath|scrub|grassland)$"](${bb});
way["leisure"~"^(park|garden|nature_reserve|common|recreation_ground|village_green)$"](${bb});
way["landuse"~"^(forest|meadow|recreation_ground|village_green|grass|cemetery)$"](${bb});
relation["leisure"="park"](${bb});
relation["natural"="water"](${bb});
);out geom;`;
  let lastErr: unknown;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!res.ok) throw new Error(`Map data server busy (${res.status})`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Couldn't download map data");
}

type Ring = { pts: Float64Array; minx: number; miny: number; maxx: number; maxy: number };

function buildGraph(data: any, bbox: [number, number, number, number]): Graph {
  const lat0 = (bbox[1] + bbox[3]) / 2;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;

  const nodeIdx = new Map<number, number>();
  const lons: number[] = [], lats: number[] = [];
  const node = (id: number, lon: number, lat: number) => {
    let i = nodeIdx.get(id);
    if (i === undefined) {
      i = lons.length; nodeIdx.set(id, i); lons.push(lon); lats.push(lat);
    }
    return i;
  };
  const names = [""];
  const nameIdx = new Map<string, number>([["", 0]]);

  const eU: number[] = [], eV: number[] = [], eInfo: WayInfo[] = [], eNameI: number[] = [];
  const green: Ring[] = [], water: Ring[] = [], waterLines: Ring[] = [];

  const toRing = (geom: { lat: number; lon: number }[]): Ring => {
    const pts = new Float64Array(geom.length * 2);
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    geom.forEach((g, i) => {
      const x = g.lon * kx, y = g.lat * ky;
      pts[2 * i] = x; pts[2 * i + 1] = y;
      minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
    });
    return { pts, minx, miny, maxx, maxy };
  };
  const closed = (g: { lat: number; lon: number }[]) =>
    g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;

  for (const el of data.elements ?? []) {
    const t: Tags = el.tags ?? {};
    if (el.type === "relation") {
      const isGreen = GREEN(t), isWater = WATER_AREA(t);
      for (const m of el.members ?? []) {
        if (m.type === "way" && m.role !== "inner" && m.geometry && closed(m.geometry)) {
          (isGreen ? green : isWater ? water : []).push(toRing(m.geometry));
        }
      }
      continue;
    }
    if (el.type !== "way" || !el.geometry) continue;
    const geom = el.geometry as { lat: number; lon: number }[];
    if (WATER_LINE(t)) waterLines.push(toRing(geom));
    if (!t.highway && closed(geom)) {
      if (GREEN(t)) green.push(toRing(geom));
      else if (WATER_AREA(t)) water.push(toRing(geom));
    }
    const info = classify(t);
    if (!info) continue;
    let ni = nameIdx.get(info.name);
    if (ni === undefined) { ni = names.length; names.push(info.name); nameIdx.set(info.name, ni); }
    const ids: number[] = el.nodes;
    for (let k = 0; k < ids.length - 1; k++) {
      const a = geom[k], b = geom[k + 1];
      if (!a || !b) continue; // node outside the downloaded area
      eU.push(node(ids[k], a.lon, a.lat));
      eV.push(node(ids[k + 1], b.lon, b.lat));
      eInfo.push(info);
      eNameI.push(ni);
    }
  }

  const n = lons.length, m = eU.length;
  const lon = Float64Array.from(lons), lat = Float64Array.from(lats);
  const eLen = new Float64Array(m), eCls = new Uint8Array(m), eInfra = new Uint8Array(m),
    eUnpaved = new Uint8Array(m), eGreen = new Float32Array(m), eName = Int32Array.from(eNameI);

  const greenIdx = gridIndex(green), waterIdx = gridIndex(water), lineIdx = gridIndex(waterLines);
  const degree = new Int32Array(n);
  for (let e = 0; e < m; e++) {
    const u = eU[e], v = eV[e];
    const dx = (lon[v] - lon[u]) * kx, dy = (lat[v] - lat[u]) * ky;
    eLen[e] = Math.hypot(dx, dy);
    const inf = eInfo[e];
    eCls[e] = inf.cls; eInfra[e] = +inf.infra; eUnpaved[e] = +inf.unpaved;
    const mx = ((lon[u] + lon[v]) / 2) * kx, my = ((lat[u] + lat[v]) / 2) * ky;
    eGreen[e] = inPoly(greenIdx, mx, my) || inPoly(waterIdx, mx, my) ||
      nearLine(waterIdx, mx, my, 35) || nearLine(lineIdx, mx, my, 35) ? 1 : 0;
    degree[u]++; degree[v]++;
  }

  // arcs
  const cnt = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    if (eInfo[e].fwd) cnt[eU[e] + 1]++;
    if (eInfo[e].bwd) cnt[eV[e] + 1]++;
  }
  for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
  const total = cnt[n];
  const to = new Int32Array(total), edge = new Int32Array(total), mode = new Uint8Array(total), contra = new Uint8Array(total);
  const fill = cnt.slice(0, n);
  for (let e = 0; e < m; e++) {
    const inf = eInfo[e];
    if (inf.fwd) { const a = fill[eU[e]]++; to[a] = eV[e]; edge[a] = e; mode[a] = inf.fwd; contra[a] = +inf.fwdContra; }
    if (inf.bwd) { const a = fill[eV[e]]++; to[a] = eU[e]; edge[a] = e; mode[a] = inf.bwd; contra[a] = +inf.bwdContra; }
  }
  const edgeEnd = Array.from(degree, (d) => d > 2);
  return { kx, ky, lon, lat, start: cnt, to, edge, mode, contra, eLen, eCls, eInfra, eUnpaved, eGreen, eName,
    edgeEnd, names, bbox };
}

// ---------------------------------------------------------------- geometry helpers
const CELL = 250;
type Grid = { cells: Map<string, Ring[]> };
function gridIndex(rings: Ring[]): Grid {
  const cells = new Map<string, Ring[]>();
  for (const r of rings) {
    for (let cx = Math.floor((r.minx - 40) / CELL); cx <= Math.floor((r.maxx + 40) / CELL); cx++)
      for (let cy = Math.floor((r.miny - 40) / CELL); cy <= Math.floor((r.maxy + 40) / CELL); cy++) {
        const k = cx + ":" + cy;
        let l = cells.get(k);
        if (!l) cells.set(k, (l = []));
        l.push(r);
      }
  }
  return { cells };
}
function candidates(g: Grid, x: number, y: number) {
  return g.cells.get(Math.floor(x / CELL) + ":" + Math.floor(y / CELL)) ?? [];
}
function inPoly(g: Grid, x: number, y: number) {
  for (const r of candidates(g, x, y)) {
    if (x < r.minx || x > r.maxx || y < r.miny || y > r.maxy) continue;
    let inside = false;
    const p = r.pts;
    for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) {
      const xi = p[2 * i], yi = p[2 * i + 1], xj = p[2 * j], yj = p[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
function nearLine(g: Grid, x: number, y: number, d: number) {
  for (const r of candidates(g, x, y)) {
    if (x < r.minx - d || x > r.maxx + d || y < r.miny - d || y > r.maxy + d) continue;
    const p = r.pts;
    for (let i = 0; i < p.length / 2 - 1; i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
      if (Math.hypot(x - (ax + t * vx), y - (ay + t * vy)) <= d) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- A*
function costs(g: Graph, p: Profile): [Float64Array, number] {
  const n = g.to.length;
  const c = new Float64Array(n);
  let minMult = Infinity;
  for (let a = 0; a < n; a++) {
    const e = g.edge[a];
    const cls = g.eCls[e];
    let mult = p.cls[cls];
    if (p.infraRelief && g.eInfra[e] && mult > 1) mult = 1 + (mult - 1) * (1 - p.infraRelief);
    if (g.eUnpaved[e]) mult *= p.unpaved;
    const walking = g.mode[a] === WALK;
    if (walking) mult = p.walk;
    if (cls === STEPS) mult = p.steps;
    if (p.green) mult *= 1 - p.green * g.eGreen[e];
    if ((walking && !p.walkOk) || (g.contra[a] && !p.contraOk)) { c[a] = -1; continue; }
    c[a] = g.eLen[e] * mult;
    minMult = Math.min(minMult, mult);
  }
  return [c, Math.max(0.05, minMult === Infinity ? 1 : minMult)];
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

function nearestNode(g: Graph, lon: number, lat: number) {
  let best = -1, bd = Infinity;
  const x = lon * g.kx, y = lat * g.ky;
  for (let i = 0; i < g.lon.length; i++) {
    if (g.start[i + 1] === g.start[i]) continue; // nothing leaves this node
    const d = Math.hypot(g.lon[i] * g.kx - x, g.lat[i] * g.ky - y);
    if (d < bd) { bd = d; best = i; }
  }
  return { node: best, dist: bd };
}

function nearestArrival(g: Graph, lon: number, lat: number) {
  // any node that can be reached (has an incoming arc)
  const incoming = new Uint8Array(g.lon.length);
  for (let a = 0; a < g.to.length; a++) incoming[g.to[a]] = 1;
  let best = -1, bd = Infinity;
  const x = lon * g.kx, y = lat * g.ky;
  for (let i = 0; i < g.lon.length; i++) {
    if (!incoming[i]) continue;
    const d = Math.hypot(g.lon[i] * g.kx - x, g.lat[i] * g.ky - y);
    if (d < bd) { bd = d; best = i; }
  }
  return { node: best, dist: bd };
}

function astar(g: Graph, profile: string, s: number, t: number) {
  const p = PROFILES[profile];
  const [c, minMult] = costs(g, p);
  const n = g.lon.length;
  const gs = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const tx = g.lon[t] * g.kx, ty = g.lat[t] * g.ky;
  const h = (i: number) => minMult * Math.hypot(g.lon[i] * g.kx - tx, g.lat[i] * g.ky - ty);
  const heap = new Heap();
  gs[s] = 0;
  heap.push(h(s), s);
  const closed = new Uint8Array(n);
  while (heap.size) {
    const [, u] = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === t) break;
    const gu = gs[u];
    for (let a = g.start[u]; a < g.start[u + 1]; a++) {
      const ca = c[a];
      if (ca < 0) continue;
      const v = g.to[a];
      const extra = p.perEdge && g.edgeEnd[u] ? p.perEdge : 0;
      const ng = gu + ca + extra;
      if (ng < gs[v]) { gs[v] = ng; prev[v] = a; heap.push(ng + h(v), v); }
    }
  }
  if (gs[t] === Infinity) return null;
  const arcs: number[] = [];
  for (let v = t; v !== s; ) {
    const a = prev[v];
    arcs.push(a);
    // find the arc's tail: the node whose arc range contains a
    v = tailOf(g, a);
  }
  return arcs.reverse();
}

function tailOf(g: Graph, a: number) {
  let lo = 0, hi = g.lon.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.start[mid] <= a) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------- assemble
function assemble(g: Graph, from: LngLat, to: LngLat, arcs: number[]) {
  type L = { kind: "ride" | "walk"; reason: string | null; coords: LngLat[]; distance_m: number; names: string[] };
  const legs: L[] = [];
  let dist = 0, ride = 0, walkM = 0, greenM = 0, eta = 0;
  const push = (kind: "ride" | "walk", reason: string | null, a: LngLat, b: LngLat, len: number, name: string, isGreen: number, steps: boolean) => {
    dist += len; greenM += len * isGreen;
    if (kind === "ride") { ride += len; eta += len / RIDE_MPS; } else { walkM += len; eta += len / (steps ? STEPS_MPS : WALK_MPS); }
    const last = legs[legs.length - 1];
    if (last && last.kind === kind && last.reason === reason) {
      last.coords.push(b); last.distance_m += len;
      if (name && !last.names.includes(name)) last.names.push(name);
    } else {
      legs.push({ kind, reason, coords: [a, b], distance_m: len, names: name ? [name] : [] });
    }
  };
  const nodeLL = (i: number): LngLat => [g.lon[i], g.lat[i]];
  const s = arcs.length ? tailOf(g, arcs[0]) : -1;
  const gap = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * g.kx, (a[1] - b[1]) * g.ky);
  if (s >= 0) push("ride", null, from, nodeLL(s), gap(from, nodeLL(s)), "", 0, false);
  let junctions = 0;
  for (const a of arcs) {
    const e = g.edge[a];
    const u = tailOf(g, a), v = g.to[a];
    const steps = g.eCls[e] === STEPS;
    const kind = g.mode[a] === WALK || steps ? "walk" : "ride";
    const reason = kind === "walk" ? (steps ? "steps" : g.contra[a] ? "one-way" : "footpath") : null;
    if (kind === "ride" && g.edgeEnd[u]) junctions++;
    push(kind, reason, nodeLL(u), nodeLL(v), g.eLen[e], g.names[g.eName[e]], g.eGreen[e], steps);
  }
  const end = arcs.length ? g.to[arcs[arcs.length - 1]] : -1;
  if (end >= 0) push("ride", null, nodeLL(end), to, gap(nodeLL(end), to), "", 0, false);
  eta += junctions * JUNCTION_S;
  const walks = legs.filter((l) => l.kind === "walk" && l.distance_m >= 15);
  return {
    distance_m: Math.round(dist), eta_s: Math.round(eta), ride_m: Math.round(ride), walk_m: Math.round(walkM),
    green_pct: dist ? Math.round((100 * greenM) / dist) : 0,
    walk_throughs: walks.map((l) => ({ reason: l.reason!, distance_m: Math.round(l.distance_m), name: l.names[0] ?? null })),
    legs: legs.map((l) => ({ ...l, distance_m: Math.round(l.distance_m) })),
    saved_s: null as number | null,
  };
}

// ---------------------------------------------------------------- public
let cache: Graph | null = null;

function contains(b: [number, number, number, number], p: LngLat) {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

export async function routeInBrowser(from: LngLat, to: LngLat, status: (msg: string) => void) {
  const kx = 111320 * Math.cos((from[1] * Math.PI) / 180);
  const crow = Math.hypot((from[0] - to[0]) * kx, (from[1] - to[1]) * 110540);
  if (crow > 12000) throw new Error("The test version handles trips up to about 12 km. Pick somewhere closer.");
  const pad = Math.max(700, crow * 0.3);
  const padLon = pad / kx, padLat = pad / 110540;
  const bbox: [number, number, number, number] = [
    Math.min(from[0], to[0]) - padLon, Math.min(from[1], to[1]) - padLat,
    Math.max(from[0], to[0]) + padLon, Math.max(from[1], to[1]) + padLat,
  ];
  let g = cache;
  if (!g || !contains(g.bbox, [bbox[0], bbox[1]]) || !contains(g.bbox, [bbox[2], bbox[3]])) {
    status("Downloading the streets around your trip…");
    const data = await overpass(bbox);
    status("Finding your line…");
    await new Promise((r) => setTimeout(r, 30));
    g = buildGraph(data, bbox);
    cache = g;
  } else {
    status("Finding your line…");
    await new Promise((r) => setTimeout(r, 30));
  }
  const s = nearestNode(g, from[0], from[1]);
  const t = nearestArrival(g, to[0], to[1]);
  if (s.node < 0 || t.node < 0 || s.dist > 400 || t.dist > 400)
    throw new Error("Couldn't find a street near there. Try a point on a road or path.");

  const run = (p: string) => {
    const arcs = astar(g!, p, s.node, t.node);
    return arcs ? assemble(g!, from, to, arcs) : null;
  };
  const std = run("standard");
  const routes: Record<string, ReturnType<typeof assemble>> = {};
  for (const m of ["direct", "chill", "scenic"]) {
    const r = run(m);
    if (!r) throw new Error("Couldn't find a way through. Try a point on a street.");
    r.saved_s = std ? std.eta_s - r.eta_s : null;
    routes[m] = r;
  }
  return { routes, standard: std ? { distance_m: std.distance_m, eta_s: std.eta_s } : null };
}

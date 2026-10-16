import maplibregl, { GeoJSONSource, LngLatBoundsLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

type Mode = "direct" | "chill" | "scenic";
type LngLat = [number, number];

interface Leg {
  kind: "ride" | "walk";
  reason: "one-way" | "footpath" | "steps" | null;
  distance_m: number;
  names: string[];
  coords: LngLat[];
}
interface Route {
  distance_m: number;
  eta_s: number;
  ride_m: number;
  walk_m: number;
  green_pct: number;
  saved_s: number | null;
  walk_throughs: { reason: string; distance_m: number; name: string | null }[];
  legs: Leg[];
}
interface RoutesResponse {
  routes: Record<Mode, Route>;
  standard: { distance_m: number; eta_s: number } | null;
}

const API = import.meta.env.VITE_API_URL ?? "";
const MAP_STYLE =
  import.meta.env.VITE_MAP_STYLE ?? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const LONDON: LngLat = [-0.1276, 51.5072];
// Rough Greater London box for search results
const BBOX = "-0.52,51.28,0.34,51.70";

const COLORS: Record<Mode, string> = { direct: "#FF6A2B", chill: "#7FB7FF", scenic: "#5FD68A" };
const VIBE: Record<Mode, string> = {
  direct: "Straightest line through the streets",
  chill: "Quiet streets, fewer junctions",
  scenic: "Parks, canals and green space",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toInput = $<HTMLInputElement>("to");
const suggestions = $<HTMLUListElement>("suggestions");
const summary = $<HTMLDivElement>("summary");
const goBtn = $<HTMLButtonElement>("go");
const fromText = $<HTMLSpanElement>("from-text");
const banner = $<HTMLDivElement>("banner");

const state: {
  mode: Mode;
  from: LngLat | null;
  fromIsMe: boolean;
  to: LngLat | null;
  data: RoutesResponse | null;
  riding: boolean;
  watch: number | null;
} = { mode: "direct", from: null, fromIsMe: true, to: null, data: null, riding: false, watch: null };

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: LONDON,
  zoom: 12,
  attributionControl: { compact: true },
});

const meEl = document.createElement("div");
meEl.className = "me";
const meMarker = new maplibregl.Marker({ element: meEl });
const pinEl = document.createElement("div");
pinEl.className = "pin";
const pinMarker = new maplibregl.Marker({ element: pinEl });

map.on("load", () => {
  map.addSource("route", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#0F1012", "line-width": 10 },
  });
  map.addLayer({
    id: "route-ride",
    type: "line",
    source: "route",
    filter: ["==", ["get", "kind"], "ride"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLORS.direct, "line-width": 6 },
  });
  map.addLayer({
    id: "route-walk",
    type: "line",
    source: "route",
    filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-join": "round" },
    paint: { "line-color": "#FFD23F", "line-width": 6, "line-dasharray": [1, 1.2] },
  });
  if (state.data) drawRoute();
});

// Tap the map to set the destination
map.on("click", (e) => {
  if (state.riding) return;
  setDestination([e.lngLat.lng, e.lngLat.lat], "Dropped pin");
});

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// ---------------------------------------------------------------- location
function locate(then?: () => void) {
  if (!("geolocation" in navigator)) {
    fromText.textContent = "Location unavailable: tap to retry";
    return;
  }
  fromText.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.from = [p.coords.longitude, p.coords.latitude];
      state.fromIsMe = true;
      fromText.textContent = "Current location";
      meMarker.setLngLat(state.from).addTo(map);
      if (!state.to) map.easeTo({ center: state.from, zoom: 14 });
      then?.();
    },
    () => {
      fromText.textContent = "Location off: tap to retry";
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

$<HTMLButtonElement>("from").addEventListener("click", () => locate(() => fetchRoutes()));
locate();

// ---------------------------------------------------------------- search
let searchTimer = 0;
let searchSeq = 0;

toInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const q = toInput.value.trim();
  if (q.length < 3) {
    suggestions.hidden = true;
    return;
  }
  searchTimer = window.setTimeout(() => search(q), 250);
});

toInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = suggestions.querySelector("button");
    first?.click();
  }
});

async function search(q: string) {
  const seq = ++searchSeq;
  const near = state.from ?? LONDON;
  const url =
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en` +
    `&lon=${near[0]}&lat=${near[1]}&bbox=${BBOX}`;
  try {
    const res = await fetch(url);
    const body = await res.json();
    if (seq !== searchSeq) return;
    renderSuggestions(body.features ?? []);
  } catch {
    if (seq === searchSeq) renderSuggestions([]);
  }
}

function renderSuggestions(features: any[]) {
  suggestions.innerHTML = "";
  if (!features.length) {
    suggestions.hidden = true;
    return;
  }
  for (const f of features) {
    const p = f.properties ?? {};
    const title = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || "Place";
    const sub = [p.street && p.name ? p.street : null, p.district ?? p.locality, p.postcode]
      .filter(Boolean)
      .join(", ");
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = title;
    if (sub) {
      const small = document.createElement("small");
      small.textContent = sub;
      btn.appendChild(small);
    }
    btn.addEventListener("click", () => {
      suggestions.hidden = true;
      setDestination(f.geometry.coordinates as LngLat, title);
      toInput.blur();
    });
    li.appendChild(btn);
    suggestions.appendChild(li);
  }
  suggestions.hidden = false;
}

function setDestination(ll: LngLat, label: string) {
  state.to = ll;
  toInput.value = label;
  pinMarker.setLngLat(ll).addTo(map);
  if (!state.from) {
    summary.innerHTML = `<p class="hint">Need your location to plan from. Tap FROM to try again.</p>`;
    locate(() => fetchRoutes());
    return;
  }
  fetchRoutes();
}

// ---------------------------------------------------------------- routing
let routeSeq = 0;

async function fetchRoutes(fit = true) {
  if (!state.from || !state.to) return;
  const seq = ++routeSeq;
  summary.innerHTML = `<p class="hint">Finding your line…</p>`;
  goBtn.disabled = true;
  const [fx, fy] = state.from;
  const [tx, ty] = state.to;
  try {
    const res = await fetch(`${API}/api/routes?from=${fy},${fx}&to=${ty},${tx}`);
    const body = await res.json();
    if (seq !== routeSeq) return;
    if (!res.ok) throw new Error(body.detail ?? "Something went wrong");
    state.data = body as RoutesResponse;
    render();
    drawRoute(fit);
  } catch (err) {
    if (seq !== routeSeq) return;
    state.data = null;
    summary.innerHTML = "";
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = (err as Error).message || "Couldn't reach the route server.";
    summary.appendChild(p);
    clearRoute();
  }
}

function current(): Route | null {
  return state.data?.routes[state.mode] ?? null;
}

function drawRoute(fit = false) {
  const r = current();
  const src = map.getSource("route") as GeoJSONSource | undefined;
  if (!src || !r) return;
  src.setData({
    type: "FeatureCollection",
    features: r.legs.map((l) => ({
      type: "Feature",
      properties: { kind: l.kind },
      geometry: { type: "LineString", coordinates: l.coords },
    })),
  });
  map.setPaintProperty("route-ride", "line-color", COLORS[state.mode]);
  if (fit) {
    const all = r.legs.flatMap((l) => l.coords);
    if (all.length) {
      const b = all.reduce(
        (acc, [x, y]) => [Math.min(acc[0], x), Math.min(acc[1], y), Math.max(acc[2], x), Math.max(acc[3], y)],
        [Infinity, Infinity, -Infinity, -Infinity],
      );
      const wide = window.innerWidth >= 760;
      map.fitBounds(b as LngLatBoundsLike, {
        padding: wide ? { top: 60, bottom: 60, left: 60, right: 60 } : { top: 140, bottom: 40, left: 40, right: 40 },
        duration: 600,
      });
    }
  }
}

function clearRoute() {
  const src = map.getSource("route") as GeoJSONSource | undefined;
  src?.setData(emptyFC());
}

function fmtKm(m: number) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function el(tag: string, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render() {
  document.documentElement.style.setProperty("--accent", COLORS[state.mode]);
  const r = current();
  summary.innerHTML = "";
  if (!r) {
    summary.appendChild(el("p", "hint", "Pick a destination to see your line."));
    goBtn.disabled = true;
    return;
  }
  goBtn.disabled = false;

  const big = el("div", "big");
  const mins = el("div", "mins", String(Math.max(1, Math.round(r.eta_s / 60))));
  mins.appendChild(el("span", undefined, "min"));
  big.appendChild(mins);
  const meta = el("div", "meta", fmtKm(r.distance_m));
  if (r.saved_s != null && Math.abs(r.saved_s) >= 60) {
    const m = Math.round(Math.abs(r.saved_s) / 60);
    meta.append("  ·  ");
    meta.appendChild(el("b", undefined, r.saved_s > 0 ? `${m} min faster` : `${m} min longer`));
    meta.append(" than the by-the-book route");
  }
  big.appendChild(meta);
  summary.appendChild(big);

  const notes = el("ul", "notes");
  const walks = r.walk_throughs;
  if (walks.length) {
    for (const w of walks.slice(0, 3)) {
      const what =
        w.reason === "one-way" ? "against the one-way" : w.reason === "steps" ? "up/down steps" : "on the footpath";
      notes.appendChild(note("#FFD23F", `Hop off: walk ${fmtKm(w.distance_m)} ${what}${w.name ? ` on ${w.name}` : ""}`));
    }
    if (walks.length > 3) notes.appendChild(note("#FFD23F", `+${walks.length - 3} more short walk-throughs`));
  } else {
    notes.appendChild(note("#FFD23F", "No walk-throughs: ride the whole way"));
  }
  const vibe = state.mode === "scenic" ? `${VIBE.scenic} (${r.green_pct}% green)` : VIBE[state.mode];
  notes.appendChild(note(COLORS[state.mode], vibe));
  summary.appendChild(notes);
}

function note(color: string, text: string) {
  const li = el("li");
  const dot = el("span", "dot");
  dot.style.background = color;
  li.appendChild(dot);
  li.appendChild(el("span", undefined, text));
  return li;
}

document.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => {
  b.addEventListener("click", () => {
    state.mode = b.dataset.mode as Mode;
    document
      .querySelectorAll<HTMLButtonElement>(".modes button")
      .forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    render();
    drawRoute(true);
  });
});

// ---------------------------------------------------------------- riding
goBtn.addEventListener("click", () => (state.riding ? stopRide() : startRide()));

function startRide() {
  const r = current();
  if (!r || !("geolocation" in navigator)) return;
  state.riding = true;
  document.body.classList.add("riding");
  goBtn.textContent = "STOP";
  goBtn.classList.add("stop");
  (document.querySelector(".search") as HTMLElement).hidden = true;
  state.watch = navigator.geolocation.watchPosition(
    (p) => onMove([p.coords.longitude, p.coords.latitude]),
    undefined,
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  if (state.from) map.easeTo({ center: state.from, zoom: 17, duration: 800 });
}

function stopRide() {
  state.riding = false;
  document.body.classList.remove("riding");
  goBtn.textContent = "GO";
  goBtn.classList.remove("stop");
  banner.hidden = true;
  (document.querySelector(".search") as HTMLElement).hidden = false;
  if (state.watch != null) navigator.geolocation.clearWatch(state.watch);
  state.watch = null;
  drawRoute(true);
}

const R = 6371000;
function dist(a: LngLat, b: LngLat) {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * k;
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy) * (Math.PI / 180) * R;
}

let lastReplan = 0;

function onMove(me: LngLat) {
  state.from = me;
  meMarker.setLngLat(me).addTo(map);
  map.easeTo({ center: me, duration: 500 });
  const r = current();
  if (!r) return;

  // Where are we along the route?
  let best = Infinity;
  let bestLeg = 0;
  let bestPt = 0;
  r.legs.forEach((l, li) =>
    l.coords.forEach((c, ci) => {
      const d = dist(me, c);
      if (d < best) [best, bestLeg, bestPt] = [d, li, ci];
    }),
  );

  // Remaining distance
  let remaining = 0;
  for (let li = bestLeg; li < r.legs.length; li++) {
    const cs = r.legs[li].coords;
    for (let ci = li === bestLeg ? bestPt : 0; ci < cs.length - 1; ci++) remaining += dist(cs[ci], cs[ci + 1]);
  }

  // Warn about the next walk-through
  const leg = r.legs[bestLeg];
  let msg = "";
  let sub = `${fmtKm(remaining)} to go`;
  if (leg.kind === "walk" && leg.distance_m >= 15) {
    msg = "Walk it";
    sub = `${why(leg)} · ${sub}`;
  } else {
    let ahead = 0;
    const cs = leg.coords;
    for (let ci = bestPt; ci < cs.length - 1; ci++) ahead += dist(cs[ci], cs[ci + 1]);
    const next = r.legs[bestLeg + 1];
    if (next && next.kind === "walk" && next.distance_m >= 15 && ahead < 80) {
      msg = `Hop off in ${Math.max(10, Math.round(ahead / 10) * 10)} m`;
      sub = `${why(next)} for ${fmtKm(next.distance_m)}`;
    }
  }
  if (best > 60) {
    msg = "Off route";
    sub = "Finding a new line from here…";
    if (Date.now() - lastReplan > 15000) {
      lastReplan = Date.now();
      fetchRoutes(false);
    }
  }
  if (remaining < 25) {
    msg = "You're there";
    sub = "Nice line.";
  }
  if (msg) {
    banner.innerHTML = "";
    banner.append(msg);
    banner.appendChild(el("small", undefined, sub));
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function why(l: Leg) {
  const on = l.names[0] ? ` on ${l.names[0]}` : "";
  if (l.reason === "one-way") return `Against the one-way${on}`;
  if (l.reason === "steps") return `Steps${on}`;
  return `Footpath${on}`;
}

// ---------------------------------------------------------------- PWA
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

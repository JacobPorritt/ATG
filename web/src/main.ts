import maplibregl, { GeoJSONSource, LngLatBoundsLike, MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { BBox, routeInBrowser, routeLeg } from "./browser-router";
import { GoogleRoute, googleKey, googleMapsLink, googleRoute, setGoogleKey } from "./google";
import { LimePrices, loadPrices, money, rideCost, savePrices } from "./lime";
import { DWELL, MOODS, Mood, Place, fetchPlaces } from "./places";
import { Plan, PlanInput, metres, plan as makePlan, retime } from "./wander";

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

const MODES: Mode[] = ["direct", "chill", "scenic"];
const API = import.meta.env.VITE_API_URL ?? "";
// Test build: route in the browser with live OpenStreetMap data, no server needed
const BROWSER_ROUTER = import.meta.env.VITE_ROUTER === "browser";
// Free OpenStreetMap vector tiles, a quiet grey map so the purple route stands out
const MAP_STYLE = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/positron";
const LONDON: LngLat = [-0.1276, 51.5072];
const BBOX = "-0.52,51.28,0.34,51.70"; // Greater London, for search

const PURPLE = "#7A3FD1";
const PURPLE_DARK = "#4B2387";
const ALT = "#B4B8C2";
const ALT_DARK = "#8B909B";

const VIBE: Record<Mode, string> = {
  direct: "Straightest line through the streets",
  chill: "Quiet streets, fewer big junctions",
  scenic: "Parks, canals and green space",
};

const ICONS = {
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="m9 21 3-7 3 3v4M8 11l3-3 3 1 2 3M12 14l-1-6"/></svg>',
  bike: '<svg viewBox="0 0 24 24"><circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="m6 17 4-8h5l3 8M9 6h3M13 9l-3 8"/></svg>',
  steps: '<svg viewBox="0 0 24 24"><path d="M4 20h4v-4h4v-4h4V8h4"/></svg>',
  ahead: '<svg viewBox="0 0 24 24"><path d="M12 20V5M6 11l6-6 6 6"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toInput = $<HTMLInputElement>("to");
const suggestions = $<HTMLUListElement>("suggestions");
const summary = $<HTMLDivElement>("summary");
const goBtn = $<HTMLButtonElement>("go");
const goLabel = $<HTMLSpanElement>("go-label");
const fromBtn = $<HTMLButtonElement>("from");
const fromText = $<HTMLSpanElement>("from-text");
const clearBtn = $<HTMLButtonElement>("clear");
const banner = $<HTMLDivElement>("banner");
const gmaps = $<HTMLAnchorElement>("gmaps");
const shuffleBtn = $<HTMLButtonElement>("shuffle");
const editBtn = $<HTMLButtonElement>("edit");

const state = {
  view: "route" as "route" | "wander",
  mode: "direct" as Mode,
  from: null as LngLat | null,
  to: null as LngLat | null,
  toLabel: "",
  data: null as RoutesResponse | null,
  status: "",
  error: "",
  riding: false,
  watch: null as number | null,
  google: null as GoogleRoute | null,
  googleStatus: "off" as "off" | "loading" | "ok" | "error",
  googleError: "",
  panel: null as null | "lime" | "google",
  prices: loadPrices() as LimePrices,
  nextStop: 0,
};

const wander = {
  stage: "setup" as "setup" | "loading" | "plan",
  budgetMin: 300,
  startTime: "",          // "HH:MM", empty = now
  onFoot: false,
  crawl: false,
  moods: new Set<Mood>(["coffee", "art", "food", "parks"]),
  status: "",
  error: "",
  seed: 0,
  excluded: new Set<string>(),
  input: null as PlanInput | null,
  plan: null as Plan | null,
  legs: [] as Route[],
  places: [] as Place[],
  placesKey: "",
};

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
pinEl.appendChild(el("span", "pin")); // the marker owns the outer transform, so rotate an inner shape
const pinMarker = new maplibregl.Marker({ element: pinEl });
let stopMarkers: maplibregl.Marker[] = [];

map.on("load", () => {
  map.addSource("alts", { type: "geojson", data: emptyFC() });
  map.addSource("google", { type: "geojson", data: emptyFC() });
  map.addSource("route", { type: "geojson", data: emptyFC() });
  map.addLayer({
    id: "alt-casing", type: "line", source: "alts",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ALT_DARK, "line-width": 9 },
  });
  map.addLayer({
    id: "alt-line", type: "line", source: "alts",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ALT, "line-width": 6 },
  });
  map.addLayer({
    id: "google-route", type: "line", source: "google",
    layout: { "line-join": "round" },
    paint: { "line-color": "#5E6470", "line-width": 3, "line-dasharray": [2, 1.5], "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "route-casing", type: "line", source: "route",
    filter: ["==", ["get", "kind"], "ride"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": PURPLE_DARK, "line-width": 10 },
  });
  map.addLayer({
    id: "route-ride", type: "line", source: "route",
    filter: ["==", ["get", "kind"], "ride"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": PURPLE, "line-width": 7 },
  });
  map.addLayer({
    id: "route-walk", type: "line", source: "route",
    filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": PURPLE, "line-width": 7, "line-dasharray": [0, 1.6] },
  });
  map.on("mouseenter", "alt-line", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "alt-line", () => (map.getCanvas().style.cursor = ""));
  drawRoutes();
});

// Tap another route to pick it; tap anywhere else to set the destination
map.on("click", (e: MapLayerMouseEvent) => {
  if (state.riding) return;
  const hit = map.getLayer("alt-line")
    ? map.queryRenderedFeatures([[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]], { layers: ["alt-line"] })
    : [];
  if (hit.length) {
    setMode(hit[0].properties.mode as Mode, false);
    return;
  }
  if (state.view === "wander" && wander.stage === "plan") return; // don't wreck a plan with a stray tap
  setDestination([e.lngLat.lng, e.lngLat.lat], "Dropped pin");
});

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// ---------------------------------------------------------------- location
function locate(then?: () => void) {
  if (!("geolocation" in navigator)) {
    fromText.textContent = "Location unavailable";
    return;
  }
  fromText.textContent = "Finding your location…";
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.from = [p.coords.longitude, p.coords.latitude];
      fromText.textContent = "Your location";
      meMarker.setLngLat(state.from).addTo(map);
      if (!state.to) map.easeTo({ center: state.from, zoom: 15 });
      render();
      then?.();
    },
    () => {
      fromText.textContent = "Location is off. Tap to try again";
    },
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

fromBtn.addEventListener("click", () => locate(() => (state.view === "route" ? fetchRoutes() : undefined)));
locate();

// ---------------------------------------------------------------- search
let searchTimer = 0;
let searchSeq = 0;

toInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  clearBtn.hidden = !toInput.value;
  const q = toInput.value.trim();
  if (q.length < 3) {
    suggestions.hidden = true;
    return;
  }
  searchTimer = window.setTimeout(() => search(q), 250);
});
toInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") suggestions.querySelector("button")?.click();
  if (e.key === "Escape") suggestions.hidden = true;
});
toInput.addEventListener("focus", () => toInput.select());
clearBtn.addEventListener("click", () => {
  state.to = null;
  state.toLabel = "";
  state.data = null;
  state.google = null;
  state.error = "";
  toInput.value = "";
  clearBtn.hidden = true;
  pinMarker.remove();
  if (state.view === "wander") wander.stage = "setup";
  render();
  drawRoutes();
  drawGoogle();
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
    if (seq === searchSeq) renderSuggestions(body.features ?? []);
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
    const sub = [p.street && p.name ? p.street : null, p.district ?? p.locality, p.postcode].filter(Boolean).join(", ");
    const li = el("li");
    const btn = el("button", undefined, title) as HTMLButtonElement;
    btn.type = "button";
    if (sub) btn.appendChild(el("small", undefined, sub));
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
  state.toLabel = label;
  toInput.value = label;
  clearBtn.hidden = false;
  pinMarker.setLngLat(ll).addTo(map);
  if (state.view === "wander") {
    // In Wander the search bar sets where the day ends (or the crawl's area)
    wander.stage = "setup";
    render();
    drawRoutes();
    return;
  }
  if (!state.from) {
    state.status = "Need your location to plan from. Tap “Your location” to try again.";
    render();
    locate(() => fetchRoutes());
    return;
  }
  fetchRoutes();
}

// ---------------------------------------------------------------- A to B routing
let routeSeq = 0;

async function fetchRoutes(fit = true) {
  if (!state.from || !state.to) return;
  const seq = ++routeSeq;
  state.data = null;
  state.error = "";
  state.status = "Finding your line…";
  render();
  drawRoutes();
  const [fx, fy] = state.from;
  const [tx, ty] = state.to;
  try {
    let body: RoutesResponse;
    if (BROWSER_ROUTER) {
      body = (await routeInBrowser(state.from, state.to, (msg) => {
        if (seq !== routeSeq) return;
        state.status = msg;
        render();
      })) as RoutesResponse;
    } else {
      const res = await fetch(`${API}/api/routes?from=${fy},${fx}&to=${ty},${tx}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail ?? "Something went wrong");
      body = json as RoutesResponse;
    }
    if (seq !== routeSeq) return;
    state.data = body;
    state.status = "";
    render();
    drawRoutes(fit);
    compareWithGoogle();
  } catch (err) {
    if (seq !== routeSeq) return;
    state.status = "";
    state.error = (err as Error).message || "Couldn't reach the route server.";
    render();
  }
}

async function compareWithGoogle() {
  const from = state.from, to = state.to;
  state.google = null;
  drawGoogle();
  if (!from || !to || !googleKey()) {
    state.googleStatus = "off";
    render();
    return;
  }
  state.googleStatus = "loading";
  render();
  try {
    const g = await googleRoute(from, to);
    if (from !== state.from || to !== state.to) return;
    state.google = g;
    state.googleStatus = g ? "ok" : "off";
  } catch (err) {
    state.googleStatus = "error";
    state.googleError = (err as Error).message || "Google's time isn't available";
  }
  render();
  drawGoogle();
}

// ---------------------------------------------------------------- Wander planning
function wanderStart(): Date {
  const now = new Date();
  if (!wander.startTime) return now;
  const [h, m] = wander.startTime.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() < now.getTime() - 3600000) d.setDate(d.getDate() + 1); // a time earlier today means tomorrow
  return d;
}

function boxAround(c: LngLat, r: number): BBox {
  const kx = 111320 * Math.cos((c[1] * Math.PI) / 180);
  return [c[0] - r / kx, c[1] - r / 110540, c[0] + r / kx, c[1] + r / 110540];
}

function boxFor(a: LngLat, b: LngLat, pad: number): BBox {
  const kx = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return [
    Math.min(a[0], b[0]) - pad / kx, Math.min(a[1], b[1]) - pad / 110540,
    Math.max(a[0], b[0]) + pad / kx, Math.max(a[1], b[1]) + pad / 110540,
  ];
}

let planSeq = 0;

async function planDay(opts: { keep?: Place[]; fill?: boolean } = {}) {
  if (!state.from) {
    wander.error = "Need your location to plan from. Tap “Your location” to try again.";
    render();
    locate();
    return;
  }
  const seq = ++planSeq;
  const crawl = wander.crawl;
  const onFoot = crawl || wander.onFoot;
  const moods: Mood[] = crawl ? ["pubs"] : [...wander.moods];
  const start: LngLat = crawl && state.to ? state.to : state.from;
  const end: LngLat | null = crawl ? null : state.to;
  wander.stage = "loading";
  wander.error = "";
  render();

  try {
    if (end && metres(start, end) > 12000) throw new Error("Wander works for trips up to about 12 km for now. Pick an end point closer by.");
    const bbox = end
      ? boxFor(start, end, Math.max(800, metres(start, end) * 0.25))
      : boxAround(start, crawl ? 1100 : onFoot ? 1600 : 3500);
    const key = bbox.map((v) => v.toFixed(3)).join(",") + "|" + moods.sort().join(",");
    if (key !== wander.placesKey) {
      wander.status = crawl ? "Finding pubs nearby…" : "Finding independent places on your way…";
      render();
      wander.places = await fetchPlaces(bbox, moods);
      wander.placesKey = key;
    }
    if (seq !== planSeq) return;
    if (!wander.places.length) throw new Error("Couldn't find any independent places for that. Try more moods or a bigger window.");

    const input: PlanInput = {
      start, end, startTime: wanderStart(), budgetMin: wander.budgetMin, onFoot, moods, crawl,
      seed: wander.seed, keep: opts.keep, exclude: wander.excluded, fill: opts.fill,
    };
    let p = makePlan(input, wander.places);
    if (!p.stops.length) throw new Error("Nothing fits in that window. Give yourself a bit more time.");

    // Real routes for each leg, then re-time the day with them
    const points: LngLat[] = [start, ...p.stops.map((s) => s.place.ll), ...(end ? [end] : [])];
    const legs: Route[] = [];
    const legMins: number[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      wander.status = `Routing the day: leg ${i + 1} of ${points.length - 1}…`;
      render();
      const r = await legRoute(points[i], points[i + 1], onFoot);
      if (seq !== planSeq) return;
      legs.push(r);
      legMins.push(r.eta_s / 60 + (onFoot ? 0 : 1.5));
    }
    p = retime(p, input.startTime, input.budgetMin, legMins);
    wander.input = input;
    wander.plan = p;
    wander.legs = legs;
    wander.stage = "plan";
    wander.status = "";
    state.nextStop = 0;
    render();
    drawRoutes(true);
  } catch (err) {
    if (seq !== planSeq) return;
    wander.stage = "setup";
    wander.status = "";
    wander.error = (err as Error).message || "Couldn't plan that. Try again in a minute.";
    render();
  }
}

async function legRoute(a: LngLat, b: LngLat, onFoot: boolean): Promise<Route> {
  if (BROWSER_ROUTER) return (await routeLeg(a, b, onFoot)) as Route;
  const res = await fetch(`${API}/api/routes?from=${a[1]},${a[0]}&to=${b[1]},${b[0]}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.detail ?? "Couldn't route between two stops");
  const r: Route = json.routes[onFoot ? "direct" : "chill"];
  if (onFoot) {
    r.eta_s = Math.round(r.distance_m / (4.5 / 3.6));
    r.legs = r.legs.map((l) => ({ ...l, kind: "ride" }));
  }
  return r;
}

function swapStop(i: number) {
  const p = wander.plan;
  if (!p) return;
  wander.excluded.add(p.stops[i].place.id);
  planDay({ keep: p.stops.slice(0, i).map((s) => s.place) });
}

function removeStop(i: number) {
  const p = wander.plan;
  if (!p) return;
  planDay({ keep: p.stops.filter((_, k) => k !== i).map((s) => s.place), fill: false });
}

function wanderRoute(): Route | null {
  if (wander.stage !== "plan" || !wander.legs.length || !wander.plan) return null;
  return {
    distance_m: wander.legs.reduce((s, r) => s + r.distance_m, 0),
    eta_s: Math.round((wander.plan.finishAt.getTime() - (wander.input?.startTime.getTime() ?? 0)) / 1000),
    ride_m: 0, walk_m: 0, green_pct: 0, saved_s: null, walk_throughs: [],
    legs: wander.legs.flatMap((r) => r.legs),
  };
}

// ---------------------------------------------------------------- drawing
function current(): Route | null {
  if (state.view === "wander") return wanderRoute();
  return state.data?.routes[state.mode] ?? null;
}

function lineFeature(coords: LngLat[], props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } };
}

function drawRoutes(fit = false) {
  const route = map.getSource("route") as GeoJSONSource | undefined;
  const alts = map.getSource("alts") as GeoJSONSource | undefined;
  stopMarkers.forEach((m) => m.remove());
  stopMarkers = [];
  if (!route || !alts) return;
  const r = current();
  if (!r) {
    route.setData(emptyFC());
    alts.setData(emptyFC());
    return;
  }
  route.setData({ type: "FeatureCollection", features: r.legs.map((l) => lineFeature(l.coords, { kind: l.kind })) });

  if (state.view === "wander") {
    alts.setData(emptyFC());
    wander.plan?.stops.forEach((s, i) => {
      const d = el("button", "stopmark", String(i + 1)) as HTMLButtonElement;
      d.type = "button";
      d.setAttribute("aria-label", `Stop ${i + 1}: ${s.place.name}`);
      d.addEventListener("click", (e) => {
        e.stopPropagation();
        document.getElementById(`stop-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      stopMarkers.push(new maplibregl.Marker({ element: d }).setLngLat(s.place.ll).addTo(map));
    });
    if (fit) fitTo([...r.legs.flatMap((l) => l.coords)]);
    return;
  }

  alts.setData({
    type: "FeatureCollection",
    features: state.riding || !state.data
      ? []
      : MODES.filter((m) => m !== state.mode).map((m) =>
          lineFeature(state.data!.routes[m].legs.flatMap((l, i) => (i ? l.coords.slice(1) : l.coords)), { mode: m }),
        ),
  });
  if (fit && state.data) fitTo(MODES.flatMap((m) => state.data!.routes[m].legs.flatMap((l) => l.coords)));
}

function fitTo(coords: LngLat[]) {
  if (!coords.length) return;
  const b = coords.reduce(
    (acc, [x, y]) => [Math.min(acc[0], x), Math.min(acc[1], y), Math.max(acc[2], x), Math.max(acc[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const wide = window.innerWidth >= 760;
  map.fitBounds(b as LngLatBoundsLike, {
    padding: wide ? { top: 70, bottom: 70, left: 70, right: 70 } : { top: 150, bottom: 40, left: 40, right: 40 },
    duration: 600,
    maxZoom: 17,
  });
}

function drawGoogle() {
  const src = map.getSource("google") as GeoJSONSource | undefined;
  if (!src) return;
  const path = state.riding || state.view === "wander" ? [] : state.google?.path ?? [];
  src.setData(path.length > 1 ? { type: "FeatureCollection", features: [lineFeature(path, {})] } : emptyFC());
}

// ---------------------------------------------------------------- formatting
function fmtDist(m: number) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
function fmtMins(s: number) {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60}` : ""}`;
}
function fmtClock(d: Date) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function fmtBudget(min: number) {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} hr ${m}` : `${h} hr`;
}

function el(tag: string, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function iconBtn(icon: keyof typeof ICONS, label: string, onClick: () => void) {
  const b = el("button", "icon-btn") as HTMLButtonElement;
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.innerHTML = ICONS[icon];
  b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------- sheet
function render() {
  document.querySelectorAll<HTMLElement>("[data-time]").forEach((t) => {
    const r = state.data?.routes[t.dataset.time as Mode];
    t.textContent = r ? fmtMins(r.eta_s) : "";
  });
  document.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => {
    const on = state.view === "wander" ? b.dataset.mode === "wander" : b.dataset.mode === state.mode;
    b.setAttribute("aria-selected", String(on));
  });
  summary.innerHTML = "";
  if (state.view === "wander") renderWander();
  else renderRoute();
  renderActions();
}

function renderActions() {
  const inPlan = state.view === "wander" && wander.stage === "plan";
  shuffleBtn.hidden = !inPlan;
  editBtn.hidden = !inPlan;
  gmaps.hidden = !(state.view === "route" && state.from && state.to);
  if (state.from && state.to) gmaps.href = googleMapsLink(state.from, state.to);
  goBtn.classList.toggle("stop", state.riding);
  if (state.riding) {
    goLabel.textContent = "Exit";
    goBtn.disabled = false;
  } else if (state.view === "route") {
    goLabel.textContent = "Let's go";
    goBtn.disabled = !current();
  } else if (wander.stage === "plan") {
    goLabel.textContent = wander.crawl ? "Start the crawl" : "Start the day";
    goBtn.disabled = false;
  } else {
    goLabel.textContent = wander.stage === "loading" ? "Planning…" : wander.crawl ? "Plan the crawl" : "Plan my day";
    goBtn.disabled = wander.stage === "loading" || (!wander.crawl && !wander.moods.size);
  }
}

function renderRoute() {
  const r = current();
  if (state.error) summary.appendChild(el("p", "error", state.error));
  else if (state.status) summary.appendChild(el("p", "hint", state.status));
  else if (!r) {
    const box = el("div", "empty");
    box.appendChild(el("h2", undefined, "Where to?"));
    box.appendChild(el("p", undefined,
      "Search for a place or tap the map. ATG finds the most direct line across town and tells you where to hop off and walk. Got time to kill? Try Wander."));
    summary.appendChild(box);
  }
  if (!r) return;

  const base = baseline();
  const diff = base ? base.s - r.eta_s : null;
  const head = el("div", "headline");
  head.appendChild(el("div", "big", fmtMins(r.eta_s)));
  head.appendChild(el("div", "dist", fmtDist(r.distance_m)));
  if (base && diff != null) {
    if (diff >= 60) head.appendChild(el("div", "tag", `${fmtMins(diff)} faster than ${base.short}`));
    else if (diff <= -60) head.appendChild(el("div", "tag bad", `${fmtMins(-diff)} slower than ${base.short}`));
    else head.appendChild(el("div", "tag plain", `Same as ${base.short}`));
  }
  summary.appendChild(head);
  summary.appendChild(el("div", "vibe", state.mode === "scenic" ? `${VIBE.scenic}, ${r.green_pct}% green` : VIBE[state.mode]));

  summary.appendChild(limeCard(r));
  if (state.panel === "lime") summary.appendChild(limeForm());
  summary.appendChild(stepsList(r));
  summary.appendChild(googleRow());
  if (state.panel === "google") summary.appendChild(googleForm());
}

/** Seconds to compare against: Google's time if we have it, else the by-the-book route. */
function baseline(): { s: number; short: string } | null {
  if (state.google) return { s: state.google.duration_s, short: "Google" };
  const std = state.data?.standard;
  return std ? { s: std.eta_s, short: "by the book" } : null;
}

function limeCard(r: Route) {
  const card = el("div", "card");
  const text = el("div", "card-text");
  const p = state.prices;
  const cost = rideCost(r.eta_s, p);
  text.appendChild(el("strong", undefined, `${money(cost)} on a Lime`));
  const line = el("div");
  const base = baseline();
  const against = base?.short === "Google" ? "Google's route" : "the by-the-book route";
  if (base) {
    const saved = rideCost(base.s, p) - cost;
    if (saved >= 0.05) {
      line.appendChild(el("span", "save", `${money(saved)} less`));
      line.append(` than ${against}`);
    } else if (saved <= -0.05) line.append(`${money(-saved)} more than ${against}`);
    else line.append(`Same price as ${against}`);
  }
  if (p.plan === "prime") {
    const mins = Math.ceil(r.eta_s / 60);
    line.append(mins <= p.primeMins ? " · fits in one LimePrime ride" : ` · over the ${p.primeMins}-min LimePrime fare`);
  }
  text.appendChild(line);
  const edit = el("button", "textbtn", state.panel === "lime" ? "Done" : "Prices") as HTMLButtonElement;
  edit.type = "button";
  edit.addEventListener("click", () => {
    state.panel = state.panel === "lime" ? null : "lime";
    render();
  });
  card.append(text, edit);
  return card;
}

function limeForm() {
  const p = state.prices;
  const form = el("form", "form") as HTMLFormElement;
  const seg = el("div", "seg");
  for (const [plan, label] of [["payg", "Pay as you go"], ["prime", "LimePrime"]] as const) {
    const b = el("button", undefined, label) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(p.plan === plan));
    b.addEventListener("click", () => {
      state.prices = { ...state.prices, plan };
      savePrices(state.prices);
      render();
    });
    seg.appendChild(b);
  }
  form.appendChild(seg);
  const row = el("div", "row");
  const field = (id: string, label: string, value: number, key: keyof LimePrices) => {
    const l = el("label", undefined, label) as HTMLLabelElement;
    l.htmlFor = id;
    const i = el("input") as HTMLInputElement;
    i.id = id;
    i.type = "number";
    i.inputMode = "decimal";
    i.step = "0.01";
    i.min = "0";
    i.value = String(value);
    i.addEventListener("change", () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v) || v < 0) return;
      state.prices = { ...state.prices, [key]: v };
      savePrices(state.prices);
      render();
    });
    l.appendChild(i);
    return l;
  };
  if (p.plan === "payg") row.append(field("lime-unlock", "Unlock (£)", p.unlock, "unlock"), field("lime-min", "Per minute (£)", p.perMin, "perMin"));
  else row.append(field("lime-flat", "Per ride (£)", p.primeFlat, "primeFlat"), field("lime-mins", "Minutes covered", p.primeMins, "primeMins"));
  form.appendChild(row);
  form.appendChild(el("p", "note", "Check the Lime app for today's prices. You still pay while walking the bike."));
  form.addEventListener("submit", (e) => e.preventDefault());
  return form;
}

function stepsList(r: Route) {
  const list = el("ul", "steps");
  const walks = r.walk_throughs;
  if (!walks.length) list.appendChild(step("bike", "Ride the whole way", "No hopping off on this one", false));
  for (const w of walks.slice(0, 4)) {
    const what = w.reason === "one-way" ? "Against the one-way" : w.reason === "steps" ? "Up or down steps" : "Along the footpath";
    list.appendChild(step(w.reason === "steps" ? "steps" : "walk", `Hop off and walk ${fmtDist(w.distance_m)}`, `${what}${w.name ? ` on ${w.name}` : ""}`, true));
  }
  if (walks.length > 4) list.appendChild(step("walk", `${walks.length - 4} more short walks`, "Dotted on the map", true));
  return list;
}

function step(icon: keyof typeof ICONS, title: string, detail: string, walk: boolean) {
  const li = el("li", walk ? "walk" : "");
  const ico = el("span", "s-ico");
  ico.innerHTML = ICONS[icon];
  const text = el("div", "s-text");
  text.appendChild(el("b", undefined, title));
  text.appendChild(el("small", undefined, detail));
  li.append(ico, text);
  return li;
}

function googleRow() {
  const row = el("div", "compare");
  if (state.googleStatus === "ok" && state.google) {
    row.appendChild(el("span", "gline"));
    row.append(`Google Maps: ${fmtMins(state.google.duration_s)} (${fmtDist(state.google.distance_m)})`);
  } else if (state.googleStatus === "loading") row.append("Checking Google Maps…");
  else if (state.googleStatus === "error") row.append(`Google Maps: ${state.googleError}`);
  else row.append("Compare with Google's cycling time");
  const b = el("button", "textbtn", state.panel === "google" ? "Close" : googleKey() ? "Key" : "Set up") as HTMLButtonElement;
  b.type = "button";
  b.addEventListener("click", () => {
    state.panel = state.panel === "google" ? null : "google";
    render();
  });
  row.appendChild(b);
  return row;
}

function googleForm() {
  const form = el("form", "form") as HTMLFormElement;
  const label = el("label", undefined, "Google Maps API key, saved on this phone only") as HTMLLabelElement;
  label.htmlFor = "gkey";
  const input = el("input") as HTMLInputElement;
  input.id = "gkey";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "AIza…";
  input.value = googleKey() ?? "";
  label.appendChild(input);
  const row = el("div", "row");
  const save = el("button", "textbtn", "Save key") as HTMLButtonElement;
  save.type = "submit";
  row.appendChild(save);
  if (googleKey()) {
    const del = el("button", "textbtn", "Remove") as HTMLButtonElement;
    del.type = "button";
    del.addEventListener("click", () => {
      setGoogleKey(null);
      state.panel = null;
      compareWithGoogle();
    });
    row.appendChild(del);
  }
  form.append(label, row);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setGoogleKey(input.value.trim() || null);
    state.panel = null;
    compareWithGoogle();
  });
  return form;
}

// ---------------------------------------------------------------- Wander sheet
function renderWander() {
  if (wander.stage === "loading") {
    summary.appendChild(el("h2", "wtitle", wander.crawl ? "Planning the crawl" : "Planning your day"));
    summary.appendChild(el("p", "hint", wander.status || "Working it out…"));
    return;
  }
  if (wander.stage === "plan" && wander.plan) return renderPlan(wander.plan);
  renderSetup();
}

function renderSetup() {
  const crawl = wander.crawl;
  summary.appendChild(el("h2", "wtitle", crawl ? "Pub crawl" : "Fill the gap."));
  if (wander.error) summary.appendChild(el("p", "error", wander.error));

  // time window
  const g1 = el("div", "wgroup");
  g1.appendChild(el("div", "label", crawl ? "How long" : "Time to play with"));
  const stepper = el("div", "stepper");
  const less = el("button", undefined, "−") as HTMLButtonElement;
  less.type = "button";
  less.setAttribute("aria-label", "Less time");
  less.addEventListener("click", () => { wander.budgetMin = Math.max(60, wander.budgetMin - 30); render(); });
  const out = el("output", undefined, fmtBudget(wander.budgetMin));
  const more = el("button", undefined, "+") as HTMLButtonElement;
  more.type = "button";
  more.setAttribute("aria-label", "More time");
  more.addEventListener("click", () => { wander.budgetMin = Math.min(600, wander.budgetMin + 30); render(); });
  stepper.append(less, out, more);
  g1.appendChild(stepper);
  summary.appendChild(g1);

  // when and where
  const box = el("div", "wbox");
  const startRow = el("label", "wfield") as HTMLLabelElement;
  startRow.htmlFor = "w-start";
  startRow.appendChild(el("span", "label", "Start"));
  startRow.appendChild(el("span", "val", wander.startTime ? "At" : "Now"));
  const time = el("input") as HTMLInputElement;
  time.id = "w-start";
  time.type = "time";
  time.value = wander.startTime || fmtClock(new Date());
  time.addEventListener("change", () => { wander.startTime = time.value; render(); });
  startRow.appendChild(time);
  box.appendChild(startRow);

  const endRow = el("div", "wfield");
  endRow.appendChild(el("span", "label", crawl ? "Area" : "End at"));
  if (crawl) endRow.appendChild(el("span", state.to ? "val" : "val soft", state.to ? `Around ${state.toLabel}` : "Around you. Search to pick an area"));
  else endRow.appendChild(el("span", state.to ? "val" : "val soft", state.to ? `${state.toLabel} by ${fmtClock(new Date(wanderStart().getTime() + wander.budgetMin * 60000))}` : "Anywhere. Search to set an end"));
  box.appendChild(endRow);
  summary.appendChild(box);

  if (crawl) {
    const n = el("p", "wnote dark");
    n.innerHTML = "<b>On foot only.</b> Leave the bike at home. ATG won't route you by bike or Lime once the crawl starts.";
    summary.appendChild(n);
  } else {
    const g2 = el("div", "wgroup");
    g2.appendChild(el("div", "label", "Getting around"));
    const seg = el("div", "seg");
    for (const [foot, label] of [[false, "By bike"], [true, "On foot"]] as const) {
      const b = el("button", undefined, label) as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("aria-pressed", String(wander.onFoot === foot));
      b.addEventListener("click", () => { wander.onFoot = foot; render(); });
      seg.appendChild(b);
    }
    g2.appendChild(seg);
    summary.appendChild(g2);

    const g3 = el("div", "wgroup");
    g3.appendChild(el("div", "label", "In the mood for"));
    const chips = el("div", "chips");
    for (const m of MOODS) {
      const c = el("button", "chip", m.label) as HTMLButtonElement;
      c.type = "button";
      c.setAttribute("aria-pressed", String(wander.moods.has(m.id)));
      c.addEventListener("click", () => {
        if (wander.moods.has(m.id)) wander.moods.delete(m.id);
        else wander.moods.add(m.id);
        render();
      });
      chips.appendChild(c);
    }
    g3.appendChild(chips);
    summary.appendChild(g3);
  }

  const crawlChip = el("button", "chip crawl", crawl ? "Pub crawl mode: on" : "Pub crawl mode") as HTMLButtonElement;
  crawlChip.type = "button";
  crawlChip.setAttribute("aria-pressed", String(crawl));
  crawlChip.addEventListener("click", () => {
    wander.crawl = !wander.crawl;
    if (wander.crawl && wander.budgetMin > 300) wander.budgetMin = 210;
    render();
  });
  const crawlRow = el("div", "chips");
  crawlRow.appendChild(crawlChip);
  summary.appendChild(crawlRow);
}

function renderPlan(p: Plan) {
  const input = wander.input!;
  const head = el("div", "phead");
  const left = el("div");
  left.appendChild(el("div", "label", input.crawl ? "Your crawl" : "Your day"));
  const km = wander.legs.reduce((s, r) => s + r.distance_m, 0);
  left.appendChild(el("div", "wtitle", `${p.stops.length} ${input.crawl ? "pubs" : p.stops.length === 1 ? "stop" : "stops"}, ${fmtDist(km)}`));
  head.appendChild(left);
  if (input.end) {
    if (p.spareMin >= 0) head.appendChild(el("div", "tag", `${p.spareMin} min spare`));
    else head.appendChild(el("div", "tag bad", `${-p.spareMin} min over`));
  } else {
    head.appendChild(el("div", "tag plain", `Done ${fmtClock(p.finishAt)}`));
  }
  summary.appendChild(head);
  if (wander.error) summary.appendChild(el("p", "error", wander.error));

  const list = el("ol", "timeline");
  const legLine = (i: number) => {
    const r = wander.legs[i];
    const li = el("li", "tl-leg");
    const rail = el("span", "tl-rail");
    rail.appendChild(el("span"));
    li.appendChild(rail);
    const mins = Math.max(1, Math.round((r?.eta_s ?? 0) / 60));
    li.appendChild(el("span", undefined, `${mins} min ${input.onFoot ? "walk" : "ride"} · ${fmtDist(r?.distance_m ?? 0)}`));
    return li;
  };
  const startLi = el("li", "tl-stop");
  const s0 = el("span", "tl-start");
  s0.appendChild(el("span"));
  startLi.appendChild(s0);
  const startBody = el("div", "tl-body");
  const sl = el("div", "line1");
  sl.append(el("span", "tl-time", fmtClock(input.startTime)), el("span", "tl-name", input.crawl && state.to ? `Start around ${state.toLabel}` : "Set off"));
  startBody.appendChild(sl);
  startLi.appendChild(startBody);
  list.appendChild(startLi);

  p.stops.forEach((s, i) => {
    list.appendChild(legLine(i));
    const li = el("li", "tl-stop");
    li.id = `stop-${i}`;
    li.appendChild(el("span", "tl-num", String(i + 1)));
    const body = el("button", "tl-body") as HTMLButtonElement;
    body.type = "button";
    body.addEventListener("click", () => map.flyTo({ center: s.place.ll, zoom: 16 }));
    const l1 = el("div", "line1");
    l1.append(el("span", "tl-time", fmtClock(s.arrive)), el("span", "tl-name", s.place.name));
    body.appendChild(l1);
    const what = el("div", "tl-what", `${s.place.kind} · ${DWELL[s.place.mood]} min`);
    if (!s.hoursKnown) {
      what.append(" · ");
      what.appendChild(el("span", "warn", "check opening times"));
    }
    body.appendChild(what);
    li.appendChild(body);
    li.appendChild(iconBtn("swap", `Swap ${s.place.name} for somewhere else`, () => swapStop(i)));
    if (p.stops.length > 1) li.appendChild(iconBtn("remove", `Remove ${s.place.name}`, () => removeStop(i)));
    list.appendChild(li);
  });

  if (input.end) {
    list.appendChild(legLine(p.stops.length));
    const endLi = el("li", "tl-stop");
    endLi.appendChild(el("span", "tl-end"));
    const b = el("div", "tl-body");
    const l1 = el("div", "line1");
    l1.append(el("span", "tl-time", fmtClock(p.finishAt)), el("span", "tl-name", state.toLabel || "Your end point"));
    b.appendChild(l1);
    endLi.appendChild(b);
    list.appendChild(endLi);
  }
  summary.appendChild(list);
  summary.appendChild(el("p", "credit", "Independent places from OpenStreetMap, chains left out. Times include a rough stay at each stop."));
}

// ---------------------------------------------------------------- controls
function setMode(m: Mode, fit = true) {
  state.mode = m;
  state.view = "route";
  render();
  drawRoutes(fit);
  drawGoogle();
  if (state.from && state.to && !state.data && !state.status) fetchRoutes();
}

document.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => {
  b.addEventListener("click", () => {
    if (state.riding) return;
    if (b.dataset.mode === "wander") {
      state.view = "wander";
      render();
      drawRoutes(true);
      drawGoogle();
      return;
    }
    setMode(b.dataset.mode as Mode);
  });
});

goBtn.addEventListener("click", () => {
  if (state.riding) return stopRide();
  if (state.view === "wander" && wander.stage === "setup") {
    wander.excluded = new Set();
    return planDay();
  }
  startRide();
});
shuffleBtn.addEventListener("click", () => {
  wander.seed++;
  wander.excluded = new Set();
  planDay();
});
editBtn.addEventListener("click", () => {
  wander.stage = "setup";
  render();
});

render();

// ---------------------------------------------------------------- riding
function startRide() {
  if (!current() || !("geolocation" in navigator)) return;
  state.riding = true;
  state.nextStop = 0;
  document.body.classList.add("riding");
  (document.querySelector(".search") as HTMLElement).hidden = true;
  state.watch = navigator.geolocation.watchPosition(
    (p) => onMove([p.coords.longitude, p.coords.latitude]),
    undefined,
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  render();
  drawRoutes();
  drawGoogle();
  const first = state.view === "wander" ? wander.plan?.stops[0]?.place.name : null;
  showBanner("ahead", first ? `First up: ${first}` : "Head off", "Follow the purple line", false);
  if (state.from) map.easeTo({ center: state.from, zoom: 17, duration: 800 });
  requestWakeLock();
}

function stopRide() {
  state.riding = false;
  document.body.classList.remove("riding");
  banner.hidden = true;
  (document.querySelector(".search") as HTMLElement).hidden = false;
  if (state.watch != null) navigator.geolocation.clearWatch(state.watch);
  state.watch = null;
  render();
  drawRoutes(true);
  drawGoogle();
  releaseWakeLock();
}

let wakeLock: any = null;
async function requestWakeLock() {
  try {
    wakeLock = await (navigator as any).wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

function showBanner(icon: keyof typeof ICONS, title: string, sub: string, walk: boolean) {
  banner.innerHTML = ICONS[icon];
  const text = el("div", undefined, title);
  text.appendChild(el("small", undefined, sub));
  banner.appendChild(text);
  banner.classList.toggle("walk", walk);
  banner.hidden = false;
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

  // Wander: tick off stops as you reach them
  const stops = state.view === "wander" ? wander.plan?.stops ?? [] : [];
  while (state.nextStop < stops.length && dist(me, stops[state.nextStop].place.ll) < 40) state.nextStop++;

  let best = Infinity, bestLeg = 0, bestPt = 0;
  r.legs.forEach((l, li) =>
    l.coords.forEach((c, ci) => {
      const d = dist(me, c);
      if (d < best) [best, bestLeg, bestPt] = [d, li, ci];
    }),
  );
  let remaining = 0;
  for (let li = bestLeg; li < r.legs.length; li++) {
    const cs = r.legs[li].coords;
    for (let ci = li === bestLeg ? bestPt : 0; ci < cs.length - 1; ci++) remaining += dist(cs[ci], cs[ci + 1]);
  }

  if (remaining < 25) {
    showBanner("flag", "You've arrived", state.view === "wander" ? "Good day out." : "Nice line.", false);
    return;
  }
  const next = stops[state.nextStop];
  if (next && dist(me, next.place.ll) < 60) {
    showBanner("pin", `${next.place.name}`, `Stop ${state.nextStop + 1} · stay till ${fmtClock(next.leave)}`, false);
    return;
  }
  if (best > 60) {
    if (state.view === "wander") {
      showBanner("ahead", "Off the line", next ? `Head for ${next.place.name}` : "Head for the finish", false);
      return;
    }
    showBanner("ahead", "Off route", "Finding a new line from here…", false);
    if (Date.now() - lastReplan > 15000) {
      lastReplan = Date.now();
      fetchRoutes(false);
    }
    return;
  }
  const leg = r.legs[bestLeg];
  if (leg.kind === "walk" && leg.distance_m >= 15) {
    showBanner("walk", "Walk the bike", `${why(leg)}`, true);
    return;
  }
  let ahead = 0;
  for (let ci = bestPt; ci < leg.coords.length - 1; ci++) ahead += dist(leg.coords[ci], leg.coords[ci + 1]);
  const nextLeg = r.legs[bestLeg + 1];
  if (nextLeg && nextLeg.kind === "walk" && nextLeg.distance_m >= 15 && ahead < 80) {
    showBanner("walk", `Hop off in ${Math.max(10, Math.round(ahead / 10) * 10)} m`, `${why(nextLeg)} for ${fmtDist(nextLeg.distance_m)}`, true);
    return;
  }
  if (next) showBanner("ahead", fmtDist(dist(me, next.place.ll)), `to ${next.place.name}`, false);
  else showBanner("ahead", fmtDist(remaining), "to go", false);
}

function why(l: Leg) {
  const on = l.names[0] ? ` on ${l.names[0]}` : "";
  if (l.reason === "one-way") return `Against the one-way${on}`;
  if (l.reason === "steps") return `Steps${on}`;
  return `Footpath${on}`;
}

// ---------------------------------------------------------------- PWA
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

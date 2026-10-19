import maplibregl, { GeoJSONSource, LngLatBoundsLike, MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { routeInBrowser } from "./browser-router";
import { GoogleRoute, googleKey, googleMapsLink, googleRoute, setGoogleKey } from "./google";
import { LimePrices, loadPrices, money, rideCost, savePrices } from "./lime";

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
// Free OpenStreetMap vector tiles with a light, familiar look
const MAP_STYLE = import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";
const LONDON: LngLat = [-0.1276, 51.5072];
const BBOX = "-0.52,51.28,0.34,51.70"; // Greater London, for search

const BLUE = "#1A73E8";
const BLUE_DARK = "#1557B0";
const ALT = "#A8B7CC";
const ALT_DARK = "#7D8FA8";

const VIBE: Record<Mode, string> = {
  direct: "Straightest line through the streets",
  chill: "Quiet streets, fewer big junctions",
  scenic: "Parks, canals and green space",
};

const ICONS = {
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="m9 21 3-7 3 3v4M8 11l3-3 3 1 2 3M12 14l-1-6"/></svg>',
  bike: '<svg viewBox="0 0 24 24"><circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="m6 17 4-8h5l3 8M9 6h3M13 9l-3 8"/></svg>',
  steps: '<svg viewBox="0 0 24 24"><path d="M4 20h4v-4h4v-4h4V8h4"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  ahead: '<svg viewBox="0 0 24 24"><path d="M12 20V5M6 11l6-6 6 6"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toInput = $<HTMLInputElement>("to");
const suggestions = $<HTMLUListElement>("suggestions");
const summary = $<HTMLDivElement>("summary");
const goBtn = $<HTMLButtonElement>("go");
const goLabel = $<HTMLSpanElement>("go-label");
const fromBtn = $<HTMLButtonElement>("from");
const fromText = $<HTMLSpanElement>("from-text");
const banner = $<HTMLDivElement>("banner");
const gmaps = $<HTMLAnchorElement>("gmaps");

const state = {
  mode: "direct" as Mode,
  from: null as LngLat | null,
  to: null as LngLat | null,
  data: null as RoutesResponse | null,
  status: "" as string,
  error: "" as string,
  riding: false,
  watch: null as number | null,
  google: null as GoogleRoute | null,
  googleStatus: "off" as "off" | "loading" | "ok" | "error",
  googleError: "",
  panel: null as null | "lime" | "google",
  prices: loadPrices() as LimePrices,
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
pinEl.className = "pin";
pinEl.innerHTML =
  '<svg viewBox="0 0 28 40" aria-hidden="true"><path d="M14 0C6.3 0 0 6.2 0 13.9 0 24.3 14 40 14 40s14-15.7 14-26.1C28 6.2 21.7 0 14 0z" fill="#EA4335"/><circle cx="14" cy="14" r="5" fill="#A50E0E"/></svg>';
const pinMarker = new maplibregl.Marker({ element: pinEl, anchor: "bottom" });

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
    paint: { "line-color": "#5F6368", "line-width": 3, "line-dasharray": [2, 1.5], "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "route-casing", type: "line", source: "route",
    filter: ["==", ["get", "kind"], "ride"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": BLUE_DARK, "line-width": 10 },
  });
  map.addLayer({
    id: "route-ride", type: "line", source: "route",
    filter: ["==", ["get", "kind"], "ride"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": BLUE, "line-width": 7 },
  });
  // Walk-it sections: Google-style dotted line
  map.addLayer({
    id: "route-walk", type: "line", source: "route",
    filter: ["==", ["get", "kind"], "walk"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": BLUE, "line-width": 7, "line-dasharray": [0, 1.6] },
  });
  map.on("mouseenter", "alt-line", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "alt-line", () => (map.getCanvas().style.cursor = ""));
  if (state.data) drawRoutes();
});

// Tap another route to pick it; tap anywhere else to set the destination
map.on("click", (e: MapLayerMouseEvent) => {
  if (state.riding) return;
  const hit = map.getLayer("alt-line")
    ? map.queryRenderedFeatures(
        [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]],
        { layers: ["alt-line"] },
      )
    : [];
  if (hit.length) {
    setMode(hit[0].properties.mode as Mode, false);
    return;
  }
  setDestination([e.lngLat.lng, e.lngLat.lat], "Dropped pin");
});

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// ---------------------------------------------------------------- location
function locate(then?: () => void) {
  if (!("geolocation" in navigator)) {
    setFrom("Location unavailable", false);
    return;
  }
  setFrom("Finding your location…", false);
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.from = [p.coords.longitude, p.coords.latitude];
      setFrom("Your location", true);
      meMarker.setLngLat(state.from).addTo(map);
      if (!state.to) map.easeTo({ center: state.from, zoom: 15 });
      then?.();
    },
    () => setFrom("Location is off. Tap to try again", false),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

function setFrom(text: string, isMe: boolean) {
  fromText.textContent = text;
  fromBtn.classList.toggle("is-me", isMe);
}

fromBtn.addEventListener("click", () => locate(() => fetchRoutes()));
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
  if (e.key === "Enter") suggestions.querySelector("button")?.click();
  if (e.key === "Escape") suggestions.hidden = true;
});
toInput.addEventListener("focus", () => toInput.select());

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
    const sub = [p.street && p.name ? p.street : null, p.district ?? p.locality, p.postcode]
      .filter(Boolean)
      .join(", ");
    const li = el("li");
    const btn = el("button") as HTMLButtonElement;
    btn.type = "button";
    const ico = el("span", "s-pin");
    ico.innerHTML = ICONS.pin;
    const text = el("span", undefined, title);
    if (sub) text.appendChild(el("small", undefined, sub));
    btn.append(ico, text);
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
    state.status = "Need your location to plan from. Tap “Your location” to try again.";
    render();
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

function current(): Route | null {
  return state.data?.routes[state.mode] ?? null;
}

function lineFeature(coords: LngLat[], props: Record<string, unknown>): GeoJSON.Feature {
  return { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } };
}

function drawRoutes(fit = false) {
  const route = map.getSource("route") as GeoJSONSource | undefined;
  const alts = map.getSource("alts") as GeoJSONSource | undefined;
  if (!route || !alts) return;
  const r = current();
  if (!r || !state.data) {
    route.setData(emptyFC());
    alts.setData(emptyFC());
    return;
  }
  route.setData({
    type: "FeatureCollection",
    features: r.legs.map((l) => lineFeature(l.coords, { kind: l.kind })),
  });
  alts.setData({
    type: "FeatureCollection",
    features: state.riding
      ? []
      : MODES.filter((m) => m !== state.mode).map((m) =>
          lineFeature(state.data!.routes[m].legs.flatMap((l, i) => (i ? l.coords.slice(1) : l.coords)), { mode: m }),
        ),
  });
  if (fit) fitTo(MODES.flatMap((m) => state.data!.routes[m].legs.flatMap((l) => l.coords)));
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
  const path = state.riding ? [] : state.google?.path ?? [];
  src.setData(path.length > 1 ? { type: "FeatureCollection", features: [lineFeature(path, {})] } : emptyFC());
}

// ---------------------------------------------------------------- sheet
function fmtDist(m: number) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
function fmtMins(s: number) {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
}

function el(tag: string, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Seconds to compare against: Google's time if we have it, else the by-the-book route. */
function baseline(): { s: number; label: string } | null {
  if (state.google) return { s: state.google.duration_s, label: "Google Maps" };
  const std = state.data?.standard;
  return std ? { s: std.eta_s, label: "the by-the-book route" } : null;
}

function render() {
  // chip times
  document.querySelectorAll<HTMLElement>("[data-time]").forEach((t) => {
    const r = state.data?.routes[t.dataset.time as Mode];
    t.textContent = r ? fmtMins(r.eta_s) : "";
  });

  const r = current();
  summary.innerHTML = "";
  gmaps.hidden = !(state.from && state.to);
  if (state.from && state.to) gmaps.href = googleMapsLink(state.from, state.to);

  if (state.error) {
    summary.appendChild(el("p", "error", state.error));
  } else if (state.status) {
    summary.appendChild(el("p", "hint", state.status));
  } else if (!r) {
    const box = el("div", "empty");
    box.appendChild(el("h2", undefined, "Where to?"));
    box.appendChild(
      el("p", undefined,
        "Search for a place or tap the map. ATG finds the most direct line across town and tells you where to hop off and walk."),
    );
    summary.appendChild(box);
  }
  goBtn.disabled = !r;
  if (!r) return;

  // headline
  const head = el("div", "headline");
  const eta = el("div", "eta");
  const base = baseline();
  const diff = base ? base.s - r.eta_s : null;
  const time = el("span", "time" + (diff != null && diff < 0 ? " slower" : ""), fmtMins(r.eta_s));
  eta.append(time, " ");
  eta.appendChild(el("span", "dist", `(${fmtDist(r.distance_m)})`));
  head.appendChild(eta);
  const sub = el("div", "sub");
  if (base && diff != null && Math.abs(diff) >= 60) {
    sub.appendChild(el("b", diff > 0 ? "" : "worse", `${fmtMins(Math.abs(diff))} ${diff > 0 ? "faster" : "slower"}`));
    sub.append(` than ${base.label} · `);
  } else if (base) {
    sub.append(`About the same as ${base.label} · `);
  }
  sub.append(state.mode === "scenic" ? `${VIBE.scenic}, ${r.green_pct}% green` : VIBE[state.mode]);
  head.appendChild(sub);
  summary.appendChild(head);

  summary.appendChild(limeCard(r));
  if (state.panel === "lime") summary.appendChild(limeForm());

  summary.appendChild(stepsList(r));
  summary.appendChild(googleRow());
  if (state.panel === "google") summary.appendChild(googleForm());
}

function limeCard(r: Route) {
  const card = el("div", "lime");
  const ico = el("span", "lime-icon");
  ico.innerHTML = ICONS.bike;
  const text = el("div", "lime-text");
  const p = state.prices;
  const cost = rideCost(r.eta_s, p);
  text.appendChild(el("strong", undefined, `${money(cost)} on a Lime`));
  const line = el("div");
  const base = baseline();
  if (base) {
    const saved = rideCost(base.s, p) - cost;
    if (saved >= 0.05) {
      line.appendChild(el("span", "save", `${money(saved)} less`));
      line.append(` than riding ${base.label === "Google Maps" ? "Google's route" : "the by-the-book route"}`);
    } else if (saved <= -0.05) {
      line.append(`${money(-saved)} more than ${base.label === "Google Maps" ? "Google's route" : "the by-the-book route"}`);
    } else {
      line.append("Same price as the standard route");
    }
  }
  if (p.plan === "prime") {
    const mins = Math.ceil(r.eta_s / 60);
    line.append(mins <= p.primeMins ? ` · fits in one LimePrime ride` : ` · over the ${p.primeMins}-min LimePrime fare`);
  }
  text.appendChild(line);
  const edit = el("button", "textbtn", state.panel === "lime" ? "Done" : "Prices") as HTMLButtonElement;
  edit.type = "button";
  edit.addEventListener("click", () => {
    state.panel = state.panel === "lime" ? null : "lime";
    render();
  });
  card.append(ico, text, edit);
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
  if (p.plan === "payg") {
    row.append(field("lime-unlock", "Unlock (£)", p.unlock, "unlock"), field("lime-min", "Per minute (£)", p.perMin, "perMin"));
  } else {
    row.append(field("lime-flat", "Per ride (£)", p.primeFlat, "primeFlat"), field("lime-mins", "Minutes covered", p.primeMins, "primeMins"));
  }
  form.appendChild(row);
  form.appendChild(el("p", "note", "Check the Lime app for today's prices. You still pay while walking the bike."));
  form.addEventListener("submit", (e) => e.preventDefault());
  return form;
}

function stepsList(r: Route) {
  const list = el("ul", "steps");
  const walks = r.walk_throughs;
  if (!walks.length) {
    list.appendChild(step("bike", "Ride the whole way", "No hopping off needed on this route", false));
  }
  for (const w of walks.slice(0, 4)) {
    const what = w.reason === "one-way" ? "against the one-way" : w.reason === "steps" ? "up or down steps" : "along the footpath";
    list.appendChild(
      step(w.reason === "steps" ? "steps" : "walk", `Hop off and walk ${fmtDist(w.distance_m)}`,
        `${what[0].toUpperCase()}${what.slice(1)}${w.name ? ` on ${w.name}` : ""}`, true),
    );
  }
  if (walks.length > 4) list.appendChild(step("walk", `${walks.length - 4} more short walks`, "Shown as dotted line on the map", true));
  return list;
}

function step(icon: keyof typeof ICONS, title: string, detail: string, walk: boolean) {
  const li = el("li", walk ? "walk" : "");
  const ico = el("span", "s-ico");
  ico.innerHTML = ICONS[icon];
  const text = el("div", "s-text", title);
  text.appendChild(el("small", undefined, detail));
  li.append(ico, text);
  return li;
}

function googleRow() {
  const row = el("div", "compare");
  if (state.googleStatus === "ok" && state.google) {
    row.appendChild(el("span", "gline"));
    row.append(`Google Maps: ${fmtMins(state.google.duration_s)} (${fmtDist(state.google.distance_m)})`);
  } else if (state.googleStatus === "loading") {
    row.append("Checking Google Maps…");
  } else if (state.googleStatus === "error") {
    row.append(`Google Maps: ${state.googleError}`);
  } else {
    row.append("Compare with Google's cycling time");
  }
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
  const save = el("button", "pill", "Save key") as HTMLButtonElement;
  save.type = "submit";
  row.appendChild(save);
  if (googleKey()) {
    const del = el("button", "pill", "Remove") as HTMLButtonElement;
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

function setMode(m: Mode, fit = true) {
  state.mode = m;
  document
    .querySelectorAll<HTMLButtonElement>(".modes button")
    .forEach((x) => x.setAttribute("aria-selected", String(x.dataset.mode === m)));
  render();
  drawRoutes(fit);
}

document.querySelectorAll<HTMLButtonElement>(".modes button").forEach((b) => {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
});

render();

// ---------------------------------------------------------------- riding
goBtn.addEventListener("click", () => (state.riding ? stopRide() : startRide()));

function startRide() {
  if (!current() || !("geolocation" in navigator)) return;
  state.riding = true;
  document.body.classList.add("riding");
  goLabel.textContent = "Exit";
  goBtn.classList.add("stop");
  (document.querySelector(".search") as HTMLElement).hidden = true;
  state.watch = navigator.geolocation.watchPosition(
    (p) => onMove([p.coords.longitude, p.coords.latitude]),
    undefined,
    { enableHighAccuracy: true, maximumAge: 2000 },
  );
  drawRoutes();
  drawGoogle();
  showBanner("ahead", "Head off", "Follow the blue line", false);
  if (state.from) map.easeTo({ center: state.from, zoom: 17, duration: 800 });
  requestWakeLock();
}

function stopRide() {
  state.riding = false;
  document.body.classList.remove("riding");
  goLabel.textContent = "Start";
  goBtn.classList.remove("stop");
  banner.hidden = true;
  (document.querySelector(".search") as HTMLElement).hidden = false;
  if (state.watch != null) navigator.geolocation.clearWatch(state.watch);
  state.watch = null;
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

  // Where are we along the route?
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
    showBanner("flag", "You've arrived", "Nice line.", false);
    return;
  }
  if (best > 60) {
    showBanner("ahead", "Off route", "Finding a new line from here…", false);
    if (Date.now() - lastReplan > 15000) {
      lastReplan = Date.now();
      fetchRoutes(false);
    }
    return;
  }
  const leg = r.legs[bestLeg];
  if (leg.kind === "walk" && leg.distance_m >= 15) {
    showBanner("walk", "Walk the bike", `${why(leg)} · ${fmtDist(remaining)} to go`, true);
    return;
  }
  let ahead = 0;
  for (let ci = bestPt; ci < leg.coords.length - 1; ci++) ahead += dist(leg.coords[ci], leg.coords[ci + 1]);
  const next = r.legs[bestLeg + 1];
  if (next && next.kind === "walk" && next.distance_m >= 15 && ahead < 80) {
    showBanner("walk", `Hop off in ${Math.max(10, Math.round(ahead / 10) * 10)} m`,
      `${why(next)} for ${fmtDist(next.distance_m)}`, true);
    return;
  }
  showBanner("ahead", fmtDist(remaining), "to go", false);
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

// Google Maps comparison: Google's total cycling time for the same trip (time only, no route geometry).
// Needs a Maps JavaScript API key with the Routes API enabled. The key is kept in
// this browser only (localStorage), or baked in at build time via VITE_GOOGLE_MAPS_KEY.

type LngLat = [number, number];

export interface GoogleRoute {
  duration_s: number;
  distance_m: number;
}

const STORE = "atg.googleKey";

export function googleKey(): string | null {
  const baked = import.meta.env.VITE_GOOGLE_MAPS_KEY;
  if (baked) return baked;
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

export function setGoogleKey(key: string | null) {
  try {
    if (key) localStorage.setItem(STORE, key);
    else localStorage.removeItem(STORE);
  } catch {
    /* private mode: key lasts for this visit only */
  }
  loader = null;
}

export function googleMapsLink(from: LngLat, to: LngLat) {
  return (
    `https://www.google.com/maps/dir/?api=1&origin=${from[1]},${from[0]}` +
    `&destination=${to[1]},${to[0]}&travelmode=bicycling`
  );
}

let loader: Promise<any> | null = null;

function loadGoogle(key: string) {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const w = window as any;
    if (w.google?.maps?.importLibrary) return resolve(w.google);
    w.__atgGoogleReady = () => resolve(w.google);
    const s = document.createElement("script");
    s.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
      `&v=weekly&loading=async&callback=__atgGoogleReady`;
    s.async = true;
    s.onerror = () => {
      loader = null;
      reject(new Error("Couldn't load Google Maps"));
    };
    w.gm_authFailure = () => reject(new Error("Google rejected the API key"));
    document.head.appendChild(s);
  });
  return loader;
}

const cache = new Map<string, GoogleRoute>();

export async function googleRoute(from: LngLat, to: LngLat): Promise<GoogleRoute | null> {
  const key = googleKey();
  if (!key) return null;
  const id = `${from.map((v) => v.toFixed(5))}|${to.map((v) => v.toFixed(5))}`;
  const hit = cache.get(id);
  if (hit) return hit;

  const google = await loadGoogle(key);
  const { Route } = await google.maps.importLibrary("routes");
  const { routes } = await Route.computeRoutes({
    origin: { lat: from[1], lng: from[0] },
    destination: { lat: to[1], lng: to[0] },
    travelMode: "BICYCLING",
    fields: ["durationMillis", "distanceMeters"],
  });
  const r = routes?.[0];
  if (!r || r.durationMillis == null) throw new Error("Google found no cycling route");
  const out = { duration_s: Math.round(r.durationMillis / 1000), distance_m: r.distanceMeters ?? 0 };
  cache.set(id, out);
  return out;
}

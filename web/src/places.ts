// Real venues for Wander, from OpenStreetMap.
// "Against the grain" curation: anything tagged with a brand (chains) is left out,
// and venues are checked against their opening hours for the time you'd arrive.
import OpeningHours from "opening_hours";
import { BBox, overpassQuery } from "./browser-router";

type LngLat = [number, number];

export type Mood = "coffee" | "art" | "food" | "pubs" | "records" | "parks" | "markets" | "vintage";

export const MOODS: { id: Mood; label: string; dwell: number }[] = [
  { id: "coffee", label: "Coffee", dwell: 25 },
  { id: "art", label: "Galleries", dwell: 45 },
  { id: "food", label: "A bite", dwell: 45 },
  { id: "pubs", label: "Pubs", dwell: 45 },
  { id: "records", label: "Record shops", dwell: 25 },
  { id: "parks", label: "Parks", dwell: 30 },
  { id: "markets", label: "Markets", dwell: 40 },
  { id: "vintage", label: "Vintage", dwell: 25 },
];

export const MOOD_LABEL: Record<Mood, string> = Object.fromEntries(MOODS.map((m) => [m.id, m.label])) as Record<Mood, string>;
export const DWELL: Record<Mood, number> = Object.fromEntries(MOODS.map((m) => [m.id, m.dwell])) as Record<Mood, number>;

export interface Place {
  id: string;
  name: string;
  mood: Mood;
  kind: string;          // what it is, in words: "Café", "Gallery"…
  ll: LngLat;
  quality: number;       // 0..4, how well documented it is (a rough proxy for "proper place")
  hours: OpeningHours | null;
  hoursText: string | null;
  tags: Record<string, string>;
}

function moodOf(t: Record<string, string>): [Mood, string] | null {
  const a = t.amenity, s = t.shop, to = t.tourism, l = t.leisure;
  if (a === "cafe") return ["coffee", "Café"];
  if (to === "gallery") return ["art", "Gallery"];
  if (to === "museum") return ["art", "Museum"];
  if (a === "arts_centre") return ["art", "Arts centre"];
  if (a === "restaurant") return ["food", t.cuisine ? cuisine(t.cuisine) : "Restaurant"];
  if (a === "fast_food") return ["food", t.cuisine ? cuisine(t.cuisine) : "Street food"];
  if (s === "bakery") return ["food", "Bakery"];
  if (a === "pub") return ["pubs", "Pub"];
  if (a === "bar") return ["pubs", "Bar"];
  if (s === "music") return ["records", "Record shop"];
  if (l === "park") return ["parks", "Park"];
  if (a === "marketplace") return ["markets", "Market"];
  if (s === "second_hand" || s === "charity") return ["vintage", s === "charity" ? "Charity shop" : "Second-hand"];
  if (s === "clothes" && (t.second_hand === "only" || t.second_hand === "yes")) return ["vintage", "Vintage clothes"];
  return null;
}

function cuisine(c: string) {
  const first = c.split(";")[0].replace(/_/g, " ");
  return first[0].toUpperCase() + first.slice(1);
}

function isChain(t: Record<string, string>) {
  return !!(t.brand || t["brand:wikidata"] || t["brand:wikipedia"]);
}

export async function fetchPlaces(bbox: BBox, moods: Mood[]): Promise<Place[]> {
  const bb = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`;
  const want = new Set(moods);
  const parts: string[] = [];
  if (want.has("coffee")) parts.push(`nwr["amenity"="cafe"]["name"](${bb});`);
  if (want.has("art")) parts.push(`nwr["tourism"~"^(gallery|museum)$"]["name"](${bb});`, `nwr["amenity"="arts_centre"]["name"](${bb});`);
  if (want.has("food")) parts.push(`nwr["amenity"~"^(restaurant|fast_food)$"]["name"](${bb});`, `nwr["shop"="bakery"]["name"](${bb});`);
  if (want.has("pubs")) parts.push(`nwr["amenity"~"^(pub|bar)$"]["name"](${bb});`);
  if (want.has("records")) parts.push(`nwr["shop"="music"]["name"](${bb});`);
  if (want.has("parks")) parts.push(`way["leisure"="park"]["name"](${bb});`, `relation["leisure"="park"]["name"](${bb});`);
  if (want.has("markets")) parts.push(`nwr["amenity"="marketplace"]["name"](${bb});`);
  if (want.has("vintage")) parts.push(`nwr["shop"~"^(second_hand|charity)$"]["name"](${bb});`, `nwr["shop"="clothes"]["second_hand"~"^(only|yes)$"]["name"](${bb});`);
  if (!parts.length) return [];
  const data = await overpassQuery(`[out:json][timeout:60];(${parts.join("")});out center tags;`);
  return parsePlaces(data, want);
}

export function parsePlaces(data: any, want: Set<Mood>): Place[] {
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const el of data.elements ?? []) {
    const t: Record<string, string> = el.tags ?? {};
    if (!t.name || isChain(t)) continue;
    if (t.access === "private" || t.disused === "yes") continue;
    const m = moodOf(t);
    if (!m || !want.has(m[0])) continue;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const key = `${m[0]}|${t.name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let hours: OpeningHours | null = null;
    const ohText = t.opening_hours ?? null;
    if (ohText) {
      try {
        hours = new OpeningHours(ohText, { lat, lon, address: { country_code: "gb", state: "England" } } as any);
      } catch {
        hours = null;
      }
    }
    const quality =
      (t.website || t["contact:website"] || t["contact:instagram"] ? 1 : 0) +
      (ohText ? 1 : 0) +
      (t.wikidata || t.wikipedia ? 1 : 0) +
      (t.cuisine || t.real_ale || t.microbrewery || t.craft || t.description || t.fee === "no" ? 1 : 0);
    out.push({ id: `${el.type}/${el.id}`, name: t.name, mood: m[0], kind: m[1], ll: [lon, lat], quality, hours, hoursText: ohText, tags: t });
  }
  return out;
}

/** Open for the whole visit? true / false, or null if we don't know. */
export function openDuring(p: Place, from: Date, to: Date): boolean | null {
  if (p.mood === "parks" && !p.hours) return true;
  if (!p.hours) return null;
  try {
    return p.hours.getState(from) && p.hours.getState(new Date(to.getTime() - 5 * 60000));
  } catch {
    return null;
  }
}

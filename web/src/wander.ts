// Wander planner: fill a time window with stops on the way to where you need to be.
//
// Rule-based for now (no AI service needed): it spreads stops along the line from
// start to finish, keeps detours short, checks each venue is open for the whole
// visit, prefers well-documented independents, and orders things sensibly
// (coffee before galleries, food mid-way, pubs last). An AI curator can later
// re-rank the same candidate list.
import { DWELL, Mood, Place, openDuring } from "./places";

type LngLat = [number, number];

export interface PlanInput {
  start: LngLat;
  end: LngLat | null;          // null: finish wherever the last stop is
  startTime: Date;
  budgetMin: number;           // whole window, including getting to the end
  onFoot: boolean;
  moods: Mood[];
  crawl: boolean;              // pub crawl: on foot, pubs only, short hops
  seed: number;                // change to shuffle
  keep?: Place[];              // stops to keep at the front (when swapping)
  exclude?: Set<string>;       // place ids not to use
  fill?: boolean;              // false: just re-time the kept stops (used when removing one)
}

export interface PlanStop {
  place: Place;
  arrive: Date;
  leave: Date;
  travelMin: number;           // getting here from the previous point
  hoursKnown: boolean;
}

export interface Plan {
  stops: PlanStop[];
  finishAt: Date;              // arrival at the end (or leaving the last stop)
  spareMin: number;            // budget left over (negative = over)
  travelToEndMin: number;
}

const ORDER: Record<Mood, number> = { coffee: 0, markets: 1, art: 2, records: 3, vintage: 3, parks: 4, food: 5, pubs: 7 };

export function speed(onFoot: boolean) {
  return onFoot ? 4.5 / 3.6 : 15 / 3.6;
}

const kx = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
export function metres(a: LngLat, b: LngLat) {
  return Math.hypot((a[0] - b[0]) * kx((a[1] + b[1]) / 2), (a[1] - b[1]) * 110540);
}

/** Rough door-to-door minutes; real routing replaces this once the plan is chosen. */
export function travelMin(a: LngLat, b: LngLat, onFoot: boolean) {
  const m = metres(a, b) * 1.35;
  return m / speed(onFoot) / 60 + (onFoot ? 0 : 1.5); // a minute or so to lock up / unlock
}

function rand(seed: number) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** Which category to look for at each slot, in a sensible order through the day. */
export function sequence(moods: Mood[], slots: number): Mood[] {
  const sorted = [...new Set(moods)].sort((a, b) => ORDER[a] - ORDER[b]);
  if (!sorted.length || slots < 1) return [];
  const others = sorted.filter((m) => m !== "pubs");
  const hasPubs = sorted.includes("pubs");
  if (!others.length) return Array(slots).fill("pubs");
  const pubSlots = hasPubs ? Math.max(1, Math.round(slots * 0.3)) : 0;
  const out: Mood[] = [];
  // round-robin through the day, each round in time-of-day order
  while (out.length < slots - pubSlots) {
    for (const m of others) if (out.length < slots - pubSlots) out.push(m);
  }
  for (let i = 0; i < pubSlots; i++) out.push("pubs");
  return out;
}

export function plan(input: PlanInput, places: Place[]): Plan {
  const { start, end, startTime, budgetMin, onFoot, crawl } = input;
  const rnd = rand(input.seed + 1);
  const jitter = new Map(places.map((p) => [p.id, rnd()]));
  const moods: Mood[] = crawl ? ["pubs"] : input.moods;
  const used = new Set<string>(input.exclude ?? []);
  const idealLeg = crawl ? 7 : onFoot ? 10 : 12;
  const avgDwell = moods.reduce((s, m) => s + DWELL[m], 0) / Math.max(1, moods.length);
  const directMin = end ? travelMin(start, end, onFoot) : 0;
  const slots = Math.max(1, Math.min(8, Math.floor((budgetMin - directMin) / (avgDwell + idealLeg * 0.8))));
  // Plan for the estimated number of stops, but keep going while there's time left
  const seq = sequence(moods, Math.max(slots, 8)).slice(0, 8);

  const stops: PlanStop[] = [];
  let cur = start;
  let t = new Date(startTime);
  const endBy = new Date(startTime.getTime() + budgetMin * 60000);
  const axisLen = end ? metres(start, end) : 0;

  const push = (p: Place, mins: number) => {
    const arrive = new Date(t.getTime() + mins * 60000);
    const leave = new Date(arrive.getTime() + DWELL[p.mood] * 60000);
    stops.push({ place: p, arrive, leave, travelMin: mins, hoursKnown: !!p.hours || p.mood === "parks" });
    used.add(p.id);
    cur = p.ll;
    t = leave;
  };

  for (const p of input.keep ?? []) push(p, travelMin(cur, p.ll, onFoot));

  for (let i = stops.length; input.fill !== false && i < seq.length; i++) {
    const mood = seq[i];
    const target = Math.min(1, (i + 1) / (slots + 1));
    let best: Place | null = null, bestScore = Infinity, bestMins = 0;
    for (const p of places) {
      if (p.mood !== mood || used.has(p.id)) continue;
      // don't pick two places right next to each other
      if (stops.some((s) => metres(s.place.ll, p.ll) < 120)) continue;
      const mins = travelMin(cur, p.ll, onFoot);
      const arrive = new Date(t.getTime() + mins * 60000);
      const leave = new Date(arrive.getTime() + DWELL[mood] * 60000);
      const tail = end ? travelMin(p.ll, end, onFoot) : 0;
      if (leave.getTime() + tail * 60000 > endBy.getTime()) continue;
      const open = openDuring(p, arrive, leave);
      if (open === false) continue;

      let score: number;
      if (end) {
        // how far along the start→end line this place sits
        const along = axisLen ? (metres(start, p.ll) ** 2 - metres(p.ll, end) ** 2 + axisLen ** 2) / (2 * axisLen * axisLen) : 0;
        const detour = mins + tail - (end ? travelMin(cur, end, onFoot) : 0);
        score = detour + Math.abs(along - target) * (axisLen / speed(onFoot) / 60) * 0.8;
      } else {
        // a crawl starts at the nearest good pub, then keeps the walks short
        score = crawl
          ? (stops.length ? Math.abs(mins - idealLeg) * 1.5 + Math.max(0, mins - 12) * 4 : mins)
          : Math.abs(mins - idealLeg);
      }
      score -= p.quality * 3;
      if (open === null) score += 6; // hours unknown: still possible, but prefer known
      score += jitter.get(p.id)! * (input.seed ? 14 : 4);
      if (score < bestScore) { bestScore = score; best = p; bestMins = mins; }
    }
    if (best) push(best, bestMins);
  }

  const travelToEndMin = end ? travelMin(cur, end, onFoot) : 0;
  const finishAt = new Date(t.getTime() + travelToEndMin * 60000);
  return { stops, finishAt, travelToEndMin, spareMin: Math.round((endBy.getTime() - finishAt.getTime()) / 60000) };
}

/** Re-time a plan once real travel times between points are known. */
export function retime(p: Plan, startTime: Date, budgetMin: number, legMins: number[]): Plan {
  let t = startTime.getTime();
  const stops = p.stops.map((s, i) => {
    const arrive = new Date(t + legMins[i] * 60000);
    const leave = new Date(arrive.getTime() + DWELL[s.place.mood] * 60000);
    t = leave.getTime();
    return { ...s, arrive, leave, travelMin: legMins[i] };
  });
  const tail = legMins[p.stops.length] ?? 0;
  const finishAt = new Date(t + tail * 60000);
  return { stops, finishAt, travelToEndMin: tail, spareMin: Math.round((startTime.getTime() + budgetMin * 60000 - finishAt.getTime()) / 60000) };
}

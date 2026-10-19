// What a ride costs on a Lime e-bike in London.
// Defaults are London pay-as-you-go prices reported in 2025/26 (about 31p a minute,
// £1 to unlock) and LimePrime (£6.99 a month, then £1.70 a ride up to 20 minutes).
// Prices change, so riders can edit them in the app; they're saved on the phone.

export type Plan = "payg" | "prime";

export interface LimePrices {
  plan: Plan;
  unlock: number;      // £ per ride, pay as you go
  perMin: number;      // £ per minute, pay as you go (and LimePrime after the flat period)
  primeFlat: number;   // £ per ride on LimePrime
  primeMins: number;   // minutes covered by the LimePrime flat fare
}

export const DEFAULT_PRICES: LimePrices = { plan: "payg", unlock: 1.0, perMin: 0.31, primeFlat: 1.7, primeMins: 20 };

const STORE = "atg.limePrices";

export function loadPrices(): LimePrices {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return { ...DEFAULT_PRICES, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_PRICES };
}

export function savePrices(p: LimePrices) {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

/** Cost of a ride lasting `seconds`. Lime bills started minutes. */
export function rideCost(seconds: number, p: LimePrices) {
  const mins = Math.max(1, Math.ceil(seconds / 60));
  if (p.plan === "prime") {
    return p.primeFlat + Math.max(0, mins - p.primeMins) * p.perMin;
  }
  return p.unlock + mins * p.perMin;
}

export function money(x: number) {
  return x < 1 ? `${Math.round(x * 100)}p` : `£${x.toFixed(2)}`;
}

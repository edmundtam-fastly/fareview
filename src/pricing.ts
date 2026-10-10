import { PROVIDERS, PROVIDER_ORDER, availabilityIn } from './providers.ts';
import type { Metro, Observation, Product, ProviderId, Quote, Route, Settings } from './types.ts';

/** Fare before calibration: max(minimum, base + distance + time) + fees. */
export function rawFare(product: Product, route: Route): number {
  const r = product.rate;
  const metered = r.base + r.perMile * route.distanceMi + r.perMin * route.durationMin;
  return Math.max(r.minFare, metered) + r.fee;
}

/**
 * Typical high-demand windows: weekday commutes and Fri/Sat late nights.
 * Used only to widen ranges and add a plain-language note — not a surge
 * prediction.
 */
export function isPeak(d: Date): boolean {
  const day = d.getDay(); // 0 = Sun
  const t = d.getHours() + d.getMinutes() / 60;
  const weekday = day >= 1 && day <= 5;
  if (weekday && ((t >= 7 && t < 9.5) || (t >= 16.5 && t < 19))) return true;
  if ((day === 5 || day === 6) && t >= 22) return true;
  if ((day === 6 || day === 0) && t < 2.5) return true;
  return false;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const MAX_SAMPLES = 12;

/**
 * Ratio of real prices to our raw estimate for a provider. Prefers the
 * rider's own metro once there are two observations there.
 */
export function calibrationFor(
  observations: Observation[],
  providerId: ProviderId,
  metroId: string | null,
): { factor: number; samples: number } | null {
  const mine = observations
    .filter((o) => o.providerId === providerId && o.rawEstimate > 0 && o.actual > 0)
    .sort((a, b) => b.ts - a.ts);
  const local = mine.filter((o) => o.metroId === metroId);
  const pool = (local.length >= 2 ? local : mine).slice(0, MAX_SAMPLES);
  if (pool.length === 0) return null;
  const factor = Math.min(2.5, Math.max(0.5, median(pool.map((o) => o.actual / o.rawEstimate))));
  return { factor, samples: pool.length };
}

export interface QuoteInput {
  route: Route;
  metro: Metro | null;
  settings: Settings;
  observations: Observation[];
  checked: Record<string, { price: number; ts: number }>;
  now: Date;
}

const PEAK_HUMAN_MARKUP = 1.1;

export function buildQuotes({ route, metro, settings, observations, checked, now }: QuoteInput): Quote[] {
  const peak = settings.peakAdjust && isPeak(now);
  const quotes: Quote[] = [];
  for (const id of PROVIDER_ORDER) {
    const pref = settings.providerPrefs[id];
    if (pref === 'hide') continue;
    const availability = availabilityIn(metro, id) ?? (pref === 'always' ? 'limited' : null);
    if (!availability) continue;
    const provider = PROVIDERS[id];
    const calibration = calibrationFor(observations, id, metro?.id ?? null);
    for (const product of provider.products) {
      const raw = rawFare(product, route);
      let mid = raw * (calibration?.factor ?? 1);
      if (peak && !provider.autonomous) mid *= PEAK_HUMAN_MARKUP;
      // Calibrated estimates earn a tighter range.
      const spread = calibration && calibration.samples >= 3 ? [0.92, 1.12] : [0.85, 1.25];
      const high = mid * spread[1] * (peak ? 1.2 : 1);
      const waitMin = provider.waitMin + (peak ? 2 : 0);
      quotes.push({
        product,
        provider,
        availability,
        rawEstimate: raw,
        calibration,
        peak,
        low: mid * spread[0],
        mid,
        high,
        waitMin,
        arrivalMin: waitMin + route.durationMin,
        checked: checked[product.id],
      });
    }
  }
  return quotes;
}

/** Live prices older than this are ignored for sorting. */
export const CHECK_TTL_MS = 15 * 60 * 1000;
/** After this a checked price gets a "may have changed" note. */
export const CHECK_STALE_MS = 5 * 60 * 1000;

export function effectivePrice(q: Quote, nowMs: number): number {
  if (q.checked && nowMs - q.checked.ts < CHECK_TTL_MS) return q.checked.price;
  return q.mid;
}

export type SortKey = 'price' | 'eta' | 'value';

export function sortQuotes(quotes: Quote[], key: SortKey, valueOfTime: number, nowMs: number): Quote[] {
  const score = (q: Quote) => {
    const price = effectivePrice(q, nowMs);
    if (key === 'price') return price;
    if (key === 'eta') return q.arrivalMin + price / 1000; // price breaks ties
    return price + valueOfTime * q.arrivalMin;
  };
  return [...quotes].sort((a, b) => score(a) - score(b));
}

export interface Filters {
  xl: boolean;
  premium: boolean;
  autonomous: boolean;
  maxPrice: number | null;
}

export function applyFilters(quotes: Quote[], f: Filters, nowMs: number): Quote[] {
  return quotes.filter((q) => {
    if (f.xl && q.product.seats < 6) return false;
    if (f.premium && !(q.product.tier === 'premium' || q.product.tier === 'comfort')) return false;
    if (f.autonomous && !q.provider.autonomous) return false;
    if (f.maxPrice != null && effectivePrice(q, nowMs) > f.maxPrice) return false;
    return true;
  });
}

/** Rider's most recent paid ride with both ends within ~400 m of this trip. */
export function lastPaidOnRoute(
  observations: Observation[],
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  distKm: (aLat: number, aLng: number, bLat: number, bLng: number) => number,
): Observation | null {
  const near = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
    distKm(a.lat, a.lng, b.lat, b.lng) < 0.4;
  return (
    observations
      .filter((o) => o.kind === 'paid' && near(o.pickup, from) && near(o.dropoff, to))
      .sort((a, b) => b.ts - a.ts)[0] ?? null
  );
}

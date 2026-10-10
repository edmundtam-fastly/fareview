import type { Availability, Metro, Product, Provider, ProviderId, RateCard, Tier } from './types.ts';

// Default rate cards are deliberately rough: providers price trips upfront and
// don't publish per-city rates. They are tuned so a ~4 mi / 16 min trip lands
// near published SF averages (Lyft ≈ $15, Uber ≈ $17, Waymo ≈ $19.5,
// Tesla ≈ $8). Your logged prices calibrate them per provider over time.

function scaled(rate: RateCard, mult: number, minFare = rate.minFare * mult): RateCard {
  return {
    base: rate.base * mult,
    perMile: rate.perMile * mult,
    perMin: rate.perMin * mult,
    fee: rate.fee,
    minFare,
  };
}

function product(
  providerId: ProviderId,
  id: string,
  name: string,
  tier: Tier,
  seats: number,
  rate: RateCard,
  lyftRideType?: string,
): Product {
  return { id, providerId, name, tier, seats, rate, lyftRideType };
}

const UBER_X: RateCard = { base: 2.0, perMile: 1.25, perMin: 0.4, fee: 3.5, minFare: 9 };
const LYFT: RateCard = { base: 1.8, perMile: 1.1, perMin: 0.36, fee: 3.2, minFare: 8.5 };
const WAYMO: RateCard = { base: 7.0, perMile: 1.55, perMin: 0.4, fee: 0, minFare: 10 };
const ZOOX: RateCard = { base: 5.0, perMile: 1.9, perMin: 0.5, fee: 0, minFare: 10 };
const TESLA: RateCard = { base: 3.0, perMile: 1.25, perMin: 0, fee: 0, minFare: 6.9 };

export const PROVIDERS: Record<ProviderId, Provider> = {
  uber: {
    id: 'uber',
    name: 'Uber',
    monogram: 'U',
    color: '#000000',
    onColor: '#ffffff',
    autonomous: false,
    waitMin: 4,
    appStoreId: '368677368',
    products: [
      product('uber', 'uber-x', 'UberX', 'standard', 4, UBER_X),
      product('uber', 'uber-comfort', 'Comfort', 'comfort', 4, scaled(UBER_X, 1.3)),
      product('uber', 'uber-xl', 'UberXL', 'xl', 6, scaled(UBER_X, 1.6)),
      product('uber', 'uber-black', 'Uber Black', 'premium', 4, scaled(UBER_X, 2.4, 18)),
    ],
    cancellation: 'Free within 2 min of booking; fee after that or if the driver has waited.',
    accessibility: 'WAV and Assist options in some cities — pick them in the Uber app.',
  },
  lyft: {
    id: 'lyft',
    name: 'Lyft',
    monogram: 'L',
    color: '#ff00bf',
    onColor: '#ffffff',
    autonomous: false,
    waitMin: 5,
    appStoreId: '529379082',
    products: [
      product('lyft', 'lyft-standard', 'Lyft', 'standard', 4, LYFT, 'lyft'),
      product('lyft', 'lyft-comfort', 'Extra Comfort', 'comfort', 4, scaled(LYFT, 1.3), 'lyft'),
      product('lyft', 'lyft-xl', 'Lyft XL', 'xl', 6, scaled(LYFT, 1.6), 'lyft_plus'),
      product('lyft', 'lyft-black', 'Lyft Black', 'premium', 4, scaled(LYFT, 2.3, 17), 'lyft_lux'),
    ],
    cancellation: 'Free within a few minutes of booking; fee after the driver is en route a while.',
    accessibility: 'Wheelchair-accessible rides in some cities via the Lyft app.',
  },
  waymo: {
    id: 'waymo',
    name: 'Waymo',
    monogram: 'W',
    color: '#0b6e6e',
    onColor: '#ffffff',
    autonomous: true,
    waitMin: 7,
    appStoreId: '1343524838',
    products: [product('waymo', 'waymo', 'Waymo', 'standard', 4, WAYMO)],
    cancellation: 'Free before the car is close; fee if it has arrived and waited.',
    accessibility: 'Rider support by phone in-car; screen-reader support in the app.',
  },
  zoox: {
    id: 'zoox',
    name: 'Zoox',
    monogram: 'Z',
    color: '#2b2d42',
    onColor: '#c8f560',
    autonomous: true,
    waitMin: 9,
    appStoreId: '1588801295',
    products: [product('zoox', 'zoox', 'Zoox', 'comfort', 4, ZOOX)],
    cancellation: 'See the Zoox app for current policy.',
    accessibility: 'Step-free, face-to-face seating; check the app for accessibility options.',
  },
  tesla: {
    id: 'tesla',
    name: 'Tesla Robotaxi',
    monogram: 'T',
    color: '#cc0000',
    onColor: '#ffffff',
    autonomous: true,
    waitMin: 9,
    appStoreId: '6744257048',
    products: [product('tesla', 'tesla', 'Robotaxi', 'standard', 4, TESLA)],
    cancellation: 'See the Robotaxi app for current policy.',
    accessibility: 'Standard Model Y; no wheelchair-accessible option.',
  },
};

export const PROVIDER_ORDER: ProviderId[] = ['uber', 'lyft', 'waymo', 'zoox', 'tesla'];

// Coverage as of Oct 2026 from press reports — service areas are zones, not
// whole metros, and change often. Riders can force a provider on or off in
// Settings when this list is wrong for them.
export const METROS: Metro[] = [
  { id: 'sf', name: 'SF Bay Area', lat: 37.62, lng: -122.2, radiusKm: 75, providers: { waymo: 'full', zoox: 'limited', tesla: 'limited' } },
  { id: 'la', name: 'Los Angeles', lat: 34.05, lng: -118.3, radiusKm: 50, providers: { waymo: 'full' } },
  { id: 'phx', name: 'Phoenix', lat: 33.45, lng: -111.95, radiusKm: 55, providers: { waymo: 'full' } },
  { id: 'aus', name: 'Austin', lat: 30.27, lng: -97.74, radiusKm: 35, providers: { waymo: 'via-uber', tesla: 'full', zoox: 'limited' } },
  { id: 'atl', name: 'Atlanta', lat: 33.75, lng: -84.39, radiusKm: 35, providers: { waymo: 'via-uber' } },
  { id: 'mia', name: 'Miami', lat: 25.78, lng: -80.21, radiusKm: 40, providers: { waymo: 'full', tesla: 'full', zoox: 'limited' } },
  { id: 'dal', name: 'Dallas', lat: 32.8, lng: -96.8, radiusKm: 45, providers: { waymo: 'full', tesla: 'full' } },
  { id: 'hou', name: 'Houston', lat: 29.76, lng: -95.37, radiusKm: 45, providers: { waymo: 'full', tesla: 'full' } },
  { id: 'sat', name: 'San Antonio', lat: 29.42, lng: -98.49, radiusKm: 35, providers: { waymo: 'full' } },
  { id: 'orl', name: 'Orlando', lat: 28.54, lng: -81.38, radiusKm: 35, providers: { waymo: 'full', tesla: 'full' } },
  { id: 'bna', name: 'Nashville', lat: 36.16, lng: -86.78, radiusKm: 35, providers: { waymo: 'full' } },
  { id: 'tpa', name: 'Tampa', lat: 27.95, lng: -82.46, radiusKm: 35, providers: { tesla: 'full' } },
  { id: 'las', name: 'Las Vegas', lat: 36.15, lng: -115.17, radiusKm: 30, providers: { zoox: 'full' } },
];

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function findMetro(lat: number, lng: number): Metro | null {
  let best: Metro | null = null;
  let bestDist = Infinity;
  for (const m of METROS) {
    const d = haversineKm(lat, lng, m.lat, m.lng);
    if (d <= m.radiusKm && d < bestDist) {
      best = m;
      bestDist = d;
    }
  }
  return best;
}

/** Uber and Lyft are treated as available everywhere; AVs only in listed metros. */
export function availabilityIn(metro: Metro | null, id: ProviderId): Availability | null {
  if (id === 'uber' || id === 'lyft') return 'full';
  return metro?.providers[id] ?? null;
}

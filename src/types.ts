export interface Place {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface Route {
  distanceMi: number;
  /** Drive time with a traffic allowance applied. */
  durationMin: number;
  /** [lat, lng] pairs for drawing; absent for approximate routes. */
  geometry?: [number, number][];
  /** True when routing failed and we fell back to straight-line math. */
  approximate: boolean;
}

export type ProviderId = 'uber' | 'lyft' | 'waymo' | 'zoox' | 'tesla';
export type Tier = 'standard' | 'comfort' | 'xl' | 'premium';

export interface RateCard {
  base: number;
  perMile: number;
  perMin: number;
  /** Booking / service fee, added after the minimum fare is applied. */
  fee: number;
  minFare: number;
}

export interface Product {
  id: string;
  providerId: ProviderId;
  name: string;
  tier: Tier;
  seats: number;
  rate: RateCard;
  /** Lyft ride-type id used to preselect the product in the handoff link. */
  lyftRideType?: string;
}

export interface Provider {
  id: ProviderId;
  name: string;
  monogram: string;
  color: string;
  onColor: string;
  autonomous: boolean;
  /** Typical minutes from request to pickup outside peak hours. */
  waitMin: number;
  appStoreId: string;
  products: Product[];
  cancellation: string;
  accessibility: string;
}

/** How a provider is available in a metro. */
export type Availability = 'full' | 'limited' | 'via-uber';

export interface Metro {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
  providers: Partial<Record<ProviderId, Availability>>;
}

export type ProviderPref = 'auto' | 'always' | 'hide';

export interface Settings {
  providerPrefs: Record<ProviderId, ProviderPref>;
  /** Dollars per minute of arrival time used by the "Best value" sort. */
  valueOfTime: number;
  peakAdjust: boolean;
}

/** A real price the rider saw (checked) or paid in a provider app. */
export interface Observation {
  id: string;
  ts: number;
  kind: 'checked' | 'paid';
  providerId: ProviderId;
  productId: string;
  productName: string;
  metroId: string | null;
  /** Our uncalibrated estimate for the same trip, for calibration. */
  rawEstimate: number;
  actual: number;
  /** Most expensive option on screen when the rider chose, for savings. */
  highestShown?: number;
  pickup: Place;
  dropoff: Place;
}

export interface Quote {
  product: Product;
  provider: Provider;
  availability: Availability;
  rawEstimate: number;
  calibration: { factor: number; samples: number } | null;
  peak: boolean;
  low: number;
  mid: number;
  high: number;
  waitMin: number;
  arrivalMin: number;
  /** Live price the rider checked in the provider app this session. */
  checked?: { price: number; ts: number };
}

import { PROVIDERS } from './providers.ts';
import type { Availability, Place, Product } from './types.ts';

export interface Handoff {
  /** App the rider ends up in, for "Booked via …" labelling. */
  appName: string;
  /** Tried first (custom URL scheme opens the installed app directly). */
  primary: string;
  /** Opened if the page is still visible shortly after the primary. */
  fallback: string;
  /** Whether pickup/dropoff arrive pre-filled; otherwise we copy the address. */
  prefilled: boolean;
}

// Uber and Lyft publish deep-link formats that carry pickup and dropoff.
// Waymo, Zoox and Tesla don't document one, so we open their App Store page
// (which shows "Open" when installed) and put the destination on the clipboard.

function q(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function uberLink(pickup: Place, dropoff: Place): Pick<Handoff, 'primary' | 'fallback'> {
  const params = q({
    action: 'setPickup',
    'pickup[latitude]': pickup.lat.toFixed(6),
    'pickup[longitude]': pickup.lng.toFixed(6),
    'pickup[nickname]': pickup.name,
    'pickup[formatted_address]': pickup.address,
    'dropoff[latitude]': dropoff.lat.toFixed(6),
    'dropoff[longitude]': dropoff.lng.toFixed(6),
    'dropoff[nickname]': dropoff.name,
    'dropoff[formatted_address]': dropoff.address,
  });
  return { primary: `uber://?${params}`, fallback: `https://m.uber.com/ul/?${params}` };
}

function lyftLink(product: Product, pickup: Place, dropoff: Place): Pick<Handoff, 'primary' | 'fallback'> {
  const params = q({
    id: product.lyftRideType ?? 'lyft',
    'pickup[latitude]': pickup.lat.toFixed(6),
    'pickup[longitude]': pickup.lng.toFixed(6),
    'destination[latitude]': dropoff.lat.toFixed(6),
    'destination[longitude]': dropoff.lng.toFixed(6),
  });
  return { primary: `lyft://ridetype?${params}`, fallback: `https://lyft.com/ride?${params}` };
}

export function handoffFor(product: Product, availability: Availability, pickup: Place, dropoff: Place): Handoff {
  if (product.providerId === 'uber' || availability === 'via-uber') {
    return { appName: 'Uber', prefilled: true, ...uberLink(pickup, dropoff) };
  }
  if (product.providerId === 'lyft') {
    return { appName: 'Lyft', prefilled: true, ...lyftLink(product, pickup, dropoff) };
  }
  const p = PROVIDERS[product.providerId];
  const store = `https://apps.apple.com/app/id${p.appStoreId}`;
  return { appName: p.name, prefilled: false, primary: `itms-apps://apps.apple.com/app/id${p.appStoreId}`, fallback: store };
}

/**
 * Open the provider app. Must be called from a tap handler so iOS allows the
 * scheme navigation and the clipboard write.
 */
export function launch(h: Handoff, dropoff: Place): void {
  if (!h.prefilled) {
    // Not awaited: the scheme navigation must stay inside the tap gesture.
    navigator.clipboard?.writeText(dropoff.address || dropoff.name).catch(() => {});
  }
  // If iOS hides the page or shows an "Open in …?" prompt (which blurs it),
  // the app is installed; otherwise fall back to the web/App Store link.
  let left = false;
  const mark = () => {
    left = true;
  };
  document.addEventListener('visibilitychange', mark, { once: true });
  window.addEventListener('blur', mark, { once: true });
  window.location.href = h.primary;
  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', mark);
    window.removeEventListener('blur', mark);
    if (!left && document.visibilityState === 'visible') window.location.href = h.fallback;
  }, 2000);
}

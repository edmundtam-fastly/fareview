import { haversineKm } from './providers.ts';
import type { Place, Route } from './types.ts';

// Free, keyless OpenStreetMap services. Fine for one person's use; both ask
// for light traffic, so searches are debounced and routes cached.
const PHOTON = 'https://photon.komoot.io';
const OSRM = 'https://router.project-osrm.org';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
    state?: string;
    postcode?: string;
    countrycode?: string;
  };
}

function toPlace(f: PhotonFeature): Place {
  const p = f.properties;
  const streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || streetLine || p.city || 'Dropped pin';
  const parts = [p.name && streetLine ? streetLine : '', p.district && p.district !== p.city ? p.district : '', p.city, p.state]
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i);
  const [lng, lat] = f.geometry.coordinates;
  return { name, address: parts.join(', ') || name, lat, lng };
}

export async function searchPlaces(query: string, near: { lat: number; lng: number } | null, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, limit: '7', lang: 'en' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lng.toFixed(4));
  }
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = (await res.json()) as { features: PhotonFeature[] };
  // OSM often has several objects (park, entrance, area) for one place: keep
  // the first of any same-named results within 300 m of each other.
  const out: Place[] = [];
  for (const p of data.features.map(toPlace)) {
    if (!out.some((o) => o.name === p.name && haversineKm(o.lat, o.lng, p.lat, p.lng) < 0.3)) out.push(p);
  }
  return out;
}

export async function reverseGeocode(lat: number, lng: number): Promise<Place> {
  try {
    const res = await fetch(`${PHOTON}/reverse?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&lang=en`);
    if (res.ok) {
      const data = (await res.json()) as { features: PhotonFeature[] };
      if (data.features[0]) return { ...toPlace(data.features[0]), lat, lng };
    }
  } catch {
    // fall through to a bare coordinate label
  }
  return { name: 'Dropped pin', address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
}

export function currentPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) =>
        reject(
          new Error(
            e.code === e.PERMISSION_DENIED
              ? 'Location permission is off. Enable it in Settings → Privacy → Location Services → Safari Websites.'
              : 'Could not get your location.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

const KM_PER_MI = 1.609344;
/** OSRM has no live traffic; pad its free-flow times. */
const TRAFFIC = { normal: 1.15, peak: 1.4 };

const routeCache = new Map<string, Route>();

export async function getRoute(from: Place, to: Place, peak: boolean): Promise<Route> {
  const key = `${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)};${peak}`;
  const hit = routeCache.get(key);
  if (hit) return hit;
  const factor = peak ? TRAFFIC.peak : TRAFFIC.normal;
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 6000);
  try {
    const url = `${OSRM}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as {
      code: string;
      routes: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
    };
    const r = data.routes?.[0];
    if (data.code !== 'Ok' || !r) throw new Error(data.code);
    const route: Route = {
      distanceMi: r.distance / 1000 / KM_PER_MI,
      durationMin: (r.duration / 60) * factor,
      geometry: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      approximate: false,
    };
    routeCache.set(key, route);
    return route;
  } catch {
    // Straight line × 1.35 at ~22 mph urban average.
    const mi = (haversineKm(from.lat, from.lng, to.lat, to.lng) * 1.35) / KM_PER_MI;
    return { distanceMi: mi, durationMin: (mi / 22) * 60 * (factor / TRAFFIC.normal), approximate: true };
  } finally {
    window.clearTimeout(timer);
  }
}

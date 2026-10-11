import type { SortKey } from './pricing.ts';
import type { Observation, Place, Settings } from './types.ts';

// Everything lives in this device's localStorage. Nothing is sent anywhere
// except place searches and routing (see geo.ts).

const KEY = 'fareview:v1';

export type PlaceKind = 'home' | 'work' | 'other';

export interface SavedPlace extends Place {
  id: string;
  kind: PlaceKind;
  /** "Home" / "Work" for those kinds; anything the rider likes otherwise. */
  label: string;
}

export interface PendingHandoff {
  ts: number;
  mode: 'book' | 'check';
  productId: string;
  highestShown: number;
}

/** The trip on screen, persisted because iOS often reloads the web app after
 * you switch to a provider app and back. */
export interface Trip {
  pickup: Place | null;
  pickupIsGps: boolean;
  dropoff: Place | null;
  checked: Record<string, { price: number; ts: number }>;
}

export interface Data {
  settings: Settings;
  sort: SortKey;
  trip: Trip;
  saved: SavedPlace[];
  recents: Place[];
  observations: Observation[];
  pending: PendingHandoff | null;
}

export const DEFAULT_SETTINGS: Settings = {
  providerPrefs: { uber: 'auto', lyft: 'auto', waymo: 'auto', zoox: 'auto', tesla: 'auto' },
  valueOfTime: 0.3,
  peakAdjust: true,
};

function fresh(): Data {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    sort: 'price',
    trip: { pickup: null, pickupIsGps: true, dropoff: null, checked: {} },
    saved: [],
    recents: [],
    observations: [],
    pending: null,
  };
}

export function load(): Data {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const d = JSON.parse(raw) as Partial<Data>;
    const base = fresh();
    return {
      settings: {
        ...base.settings,
        ...d.settings,
        providerPrefs: { ...base.settings.providerPrefs, ...d.settings?.providerPrefs },
      },
      sort: d.sort ?? base.sort,
      trip: { ...base.trip, ...d.trip },
      saved: (d.saved ?? []).map(migrateSaved),
      recents: d.recents ?? [],
      observations: d.observations ?? [],
      pending: d.pending ?? null,
    };
  } catch {
    return fresh();
  }
}

export function save(d: Data): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // Private mode or quota — the app still works for this session.
  }
}

export function clearAll(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

const samePlace = (a: Place, b: Place) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lng - b.lng) < 1e-4;

export function pushRecent(d: Data, p: Place): void {
  d.recents = [p, ...d.recents.filter((r) => !samePlace(r, p))].slice(0, 8);
}

/** Saved places from v0.1 had only a label; infer Home/Work from it. */
function migrateSaved(p: Partial<SavedPlace> & Place): SavedPlace {
  const label = p.label ?? p.name;
  const kind = p.kind ?? (/^home$/i.test(label) ? 'home' : /^work$/i.test(label) ? 'work' : 'other');
  return { ...p, id: p.id ?? newId(), kind, label };
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const KIND_LABEL: Record<Exclude<PlaceKind, 'other'>, string> = { home: 'Home', work: 'Work' };

export function savedOfKind(d: Data, kind: Exclude<PlaceKind, 'other'>): SavedPlace | undefined {
  return d.saved.find((s) => s.kind === kind);
}

/** Home, then Work, then the rest in the order they were added. */
export function orderedSaved(d: Data): SavedPlace[] {
  const rank = { home: 0, work: 1, other: 2 };
  return [...d.saved].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

export function findSaved(d: Data, p: Place): SavedPlace | undefined {
  return d.saved.find((s) => samePlace(s, p));
}

/** Insert or update by id. There is only one Home and one Work. */
export function upsertSaved(d: Data, sp: SavedPlace): void {
  const label = sp.kind === 'other' ? sp.label.trim() || sp.name : KIND_LABEL[sp.kind];
  const next = { ...sp, label };
  const at = d.saved.findIndex((s) => s.id === sp.id);
  if (at === -1) d.saved.push(next);
  else d.saved[at] = next;
  if (sp.kind !== 'other') d.saved = d.saved.filter((s) => s.id === sp.id || s.kind !== sp.kind);
}

export function removeSaved(d: Data, id: string): void {
  d.saved = d.saved.filter((s) => s.id !== id);
}

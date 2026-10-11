import { currentPosition, getRoute, reverseGeocode, searchPlaces } from './geo.ts';
import { handoffFor, launch } from './handoff.ts';
import { RoutePreview, pickOnMap } from './map.ts';
import {
  CHECK_STALE_MS,
  CHECK_TTL_MS,
  applyFilters,
  buildQuotes,
  calibrationFor,
  effectivePrice,
  isPeak,
  lastPaidOnRoute,
  sortQuotes,
  type Filters,
  type SortKey,
} from './pricing.ts';
import { PROVIDERS, PROVIDER_ORDER, availabilityIn, findMetro, haversineKm } from './providers.ts';
import {
  KIND_LABEL,
  clearAll,
  findSaved,
  load,
  newId,
  orderedSaved,
  pushRecent,
  removeSaved,
  save,
  savedOfKind,
  upsertSaved,
  type Data,
  type PlaceKind,
  type SavedPlace,
} from './store.ts';
import type { Metro, Observation, Place, ProviderPref, Quote, Route } from './types.ts';

// ---------------------------------------------------------------- helpers

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  home: svg('<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>'),
  work: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18"/>'),
  other: svg('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  recent: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3 3v4h4M12 8v4l3 2"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  locate: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>'),
  map: svg('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
};

const money = (n: number) => `$${Math.round(n)}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function shortDate(ts: number): string {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------- state

const S = {
  data: load() as Data,
  route: null as Route | null,
  routeLoading: false,
  quotedAt: 0,
  filters: { xl: false, premium: false, autonomous: false, maxPrice: null } as Filters,
  showFilters: false,
  expanded: null as string | null,
  gpsAccuracy: null as number | null,
  gpsBusy: false,
  notice: '',
};

let preview: RoutePreview | null = null;
let routeSeq = 0;

const persist = () => save(S.data);
const trip = () => S.data.trip;
const metro = (): Metro | null => {
  const p = trip().pickup;
  return p ? findMetro(p.lat, p.lng) : null;
};

function currentQuotes(): Quote[] {
  if (!S.route) return [];
  const now = new Date();
  const all = buildQuotes({
    route: S.route,
    metro: metro(),
    settings: S.data.settings,
    observations: S.data.observations,
    checked: trip().checked,
    now,
  });
  return sortQuotes(applyFilters(all, S.filters, now.getTime()), S.data.sort, S.data.settings.valueOfTime, now.getTime());
}

// ---------------------------------------------------------------- trip actions

async function useGps(): Promise<void> {
  S.gpsBusy = true;
  S.notice = '';
  renderTrip();
  try {
    const pos = await currentPosition();
    const place = await reverseGeocode(pos.lat, pos.lng);
    S.gpsAccuracy = pos.accuracy;
    trip().pickup = { ...place, name: 'Current location', address: place.address === place.name ? place.address : `${place.name}, ${place.address}` };
    trip().pickupIsGps = true;
    persist();
  } catch (e) {
    S.notice = (e as Error).message;
  } finally {
    S.gpsBusy = false;
  }
  renderAll();
  void requote();
}

function setPlace(which: 'pickup' | 'dropoff', p: Place): void {
  trip()[which] = p;
  if (which === 'pickup') {
    trip().pickupIsGps = false;
    S.gpsAccuracy = null;
  }
  pushRecent(S.data, p);
  trip().checked = {};
  S.data.pending = null;
  S.expanded = null;
  persist();
  renderAll();
  void requote();
}

function swap(): void {
  const t = trip();
  if (!t.pickup || !t.dropoff) return;
  [t.pickup, t.dropoff] = [t.dropoff, t.pickup];
  t.pickupIsGps = false;
  t.checked = {};
  persist();
  renderAll();
  void requote();
}

async function requote(): Promise<void> {
  const t = trip();
  if (!t.pickup || !t.dropoff) {
    S.route = null;
    renderAll();
    return;
  }
  const seq = ++routeSeq;
  S.routeLoading = true;
  renderQuotes();
  const route = await getRoute(t.pickup, t.dropoff, S.data.settings.peakAdjust && isPeak(new Date()));
  if (seq !== routeSeq) return;
  S.route = route;
  S.routeLoading = false;
  S.quotedAt = Date.now();
  renderAll();
  // Coming back from a provider app (iOS may have reloaded us): ask what it showed.
  if (document.visibilityState === 'visible') maybeAskForPrice();
}

// ---------------------------------------------------------------- render: main screen

function renderAll(): void {
  renderTrip();
  renderSummary();
  renderControls();
  renderQuotes();
  renderFooter();
}

function renderTrip(): void {
  const t = trip();
  const pickupLabel = S.gpsBusy ? 'Finding you…' : t.pickup ? t.pickup.name : 'Set pickup';
  const pickupSub = t.pickup && !S.gpsBusy ? t.pickup.address : '';
  $('#trip').innerHTML = `
    <button class="field" data-act="pick" data-which="pickup" aria-label="Pickup: ${esc(pickupLabel)}">
      <span class="field-dot from" aria-hidden="true"></span>
      <span class="field-text"><span class="field-main">${esc(pickupLabel)}</span>${pickupSub ? `<span class="field-sub">${esc(pickupSub)}</span>` : ''}</span>
    </button>
    <button class="field" data-act="pick" data-which="dropoff" aria-label="Destination: ${esc(t.dropoff?.name ?? 'Where to?')}">
      <span class="field-dot to" aria-hidden="true"></span>
      <span class="field-text">${
        t.dropoff
          ? `<span class="field-main">${esc(t.dropoff.name)}</span><span class="field-sub">${esc(t.dropoff.address)}</span>`
          : '<span class="field-main placeholder">Where to?</span>'
      }</span>
    </button>
    <button class="swap" data-act="swap" aria-label="Swap pickup and destination" ${t.pickup && t.dropoff ? '' : 'disabled'}>⇅</button>`;
}

function renderSummary(): void {
  const t = trip();
  const el = $('#summary');
  if (!t.pickup || !t.dropoff) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const r = S.route;
  const m = metro();
  const notes: string[] = [];
  if (r?.approximate) notes.push(`<button class="link" data-act="requote">Couldn't reach routing — distances approximate. Retry</button>`);
  if (S.gpsAccuracy != null && S.gpsAccuracy > 100 && t.pickupIsGps)
    notes.push(`Your location is approximate (±${Math.round(S.gpsAccuracy)} m). Check the pickup — precise location gives the drivers a better pickup spot.`);
  const stale = S.quotedAt && Date.now() - S.quotedAt > 5 * 60 * 1000;
  $('#summary-line').innerHTML = r
    ? `<span>${r.distanceMi.toFixed(1)} mi · ~${Math.round(r.durationMin)} min${m ? ` · ${esc(m.name)}` : ''}</span>
       <button class="link refresh ${stale ? 'stale' : ''}" data-act="requote" aria-label="Refresh estimates">${stale ? 'Refresh ↻' : `${clock(new Date(S.quotedAt))} ↻`}</button>`
    : '<span>Routing…</span>';
  $('#summary-notes').innerHTML = notes.map((n) => `<p class="note">${n}</p>`).join('');
  if (!preview) preview = new RoutePreview($('#map'));
  preview.show(t.pickup, t.dropoff, r);
}

function renderControls(): void {
  const el = $('#controls');
  el.hidden = !trip().dropoff;
  const sort = S.data.sort;
  const seg = (k: SortKey, label: string) =>
    `<button role="tab" aria-selected="${sort === k}" class="${sort === k ? 'on' : ''}" data-act="sort" data-sort="${k}">${label}</button>`;
  const f = S.filters;
  const active = [f.xl, f.premium, f.autonomous, f.maxPrice != null].filter(Boolean).length;
  const chip = (key: keyof Filters, label: string) =>
    `<button class="chip ${f[key] ? 'on' : ''}" aria-pressed="${!!f[key]}" data-act="filter" data-key="${key}">${label}</button>`;
  el.innerHTML = `
    <div class="sortbar">
      <div class="seg" role="tablist" aria-label="Sort by">${seg('price', 'Price')}${seg('eta', 'ETA')}${seg('value', 'Best value')}</div>
      <button class="icon-btn ${active ? 'badge' : ''}" data-act="toggle-filters" aria-expanded="${S.showFilters}" aria-label="Filters${active ? `, ${active} on` : ''}">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
      </button>
    </div>
    <div class="filters" ${S.showFilters ? '' : 'hidden'}>
      ${chip('xl', 'XL (6 seats)')}${chip('premium', 'Comfort & premium')}${chip('autonomous', 'Autonomous only')}
      <label class="chip maxprice ${f.maxPrice != null ? 'on' : ''}">Max $<input type="number" inputmode="numeric" min="0" step="1" value="${f.maxPrice ?? ''}" placeholder="any" data-input="maxprice" aria-label="Maximum price in dollars"></label>
    </div>`;
}

function badge(cls: string, text: string): string {
  return `<span class="badge ${cls}">${text}</span>`;
}

function quoteCard(q: Quote, bestId: string | null, fastestId: string | null, nowMs: number): string {
  const p = q.product;
  const prov = q.provider;
  const isBest = p.id === bestId;
  const expanded = S.expanded === p.id;
  const live = q.checked && nowMs - q.checked.ts < CHECK_TTL_MS ? q.checked : null;
  const arrive = clock(new Date(nowMs + q.arrivalMin * 60000));
  const price = live ? money2(live.price) : money(q.mid);
  const priceSub = live
    ? `<span class="live ${nowMs - live.ts > CHECK_STALE_MS ? 'stale' : ''}">Live · ${ago(nowMs - live.ts)}</span>`
    : `<span class="range">est. ${money(q.low)}–${money(q.high)}</span>`;
  const badges = [
    isBest ? badge('best', 'Best price') : '',
    p.id === fastestId ? badge('fast', 'Fastest') : '',
    prov.autonomous ? badge('av', 'Autonomous') : '',
    q.availability === 'via-uber' ? badge('muted', 'Via Uber') : '',
    q.availability === 'limited' ? badge('warn', 'Limited service') : '',
    q.peak && !prov.autonomous ? badge('warn', 'Busy') : '',
  ].join('');
  const priceLabel = live ? `Live price ${money2(live.price)}` : `Estimated ${money(q.mid)}, range ${money(q.low)} to ${money(q.high)}`;

  return `
  <article class="card ${isBest ? 'is-best' : ''} ${expanded ? 'open' : ''}" data-id="${p.id}">
    <div class="card-row">
      <button class="card-main" data-act="expand" data-id="${p.id}" aria-expanded="${expanded}"
        aria-label="${esc(`${p.name} by ${prov.name}. ${priceLabel}. Pickup in about ${q.waitMin} minutes, arrive around ${arrive}.`)}">
        <span class="mono" style="background:${prov.color};color:${prov.onColor}" aria-hidden="true">${prov.monogram}</span>
        <span class="card-body">
          <span class="card-title">${esc(p.name)}</span>
          <span class="card-meta">${esc(prov.name)} · ${q.waitMin} min · arrive ${arrive}</span>
          ${badges ? `<span class="badges">${badges}</span>` : ''}
        </span>
      </button>
      <div class="card-side">
        <span class="card-price" aria-hidden="true"><span class="price">${price}</span>${priceSub}</span>
        <button class="book ${isBest ? 'primary' : ''}" data-act="book" data-id="${p.id}" aria-label="Book ${esc(p.name)}">Book</button>
      </div>
    </div>
    ${expanded ? cardDetails(q) : ''}
  </article>`;
}

function cardDetails(q: Quote): string {
  const r = S.route!;
  const p = q.product;
  const lines: string[] = [];
  const calib = q.calibration
    ? `adjusted ${q.calibration.factor >= 1 ? '+' : ''}${Math.round((q.calibration.factor - 1) * 100)}% from ${q.calibration.samples} price${q.calibration.samples === 1 ? '' : 's'} you logged`
    : 'not yet calibrated — log a real price to tighten it';
  lines.push(
    `<p><strong>Why this price:</strong> typical ${esc(q.provider.name)} rates for ${r.distanceMi.toFixed(1)} mi / ${Math.round(r.durationMin)} min, including booking fees; ${calib}.${
      q.peak && !q.provider.autonomous ? ' It’s a busy time of day, so live prices are often higher than usual — we add 10% and widen the range.' : ''
    } The app’s own price is final.</p>`,
  );
  if (q.availability === 'limited')
    lines.push(`<p><strong>Coverage:</strong> ${esc(q.provider.name)} runs in limited zones here (or with a safety driver); it may not serve this trip.</p>`);
  if (q.availability === 'via-uber') lines.push('<p><strong>Booked via Uber:</strong> Waymo rides here are requested in the Uber app — you may be matched with a Waymo.</p>');
  lines.push(`<p><strong>Vehicle:</strong> ${p.seats} seats${q.provider.autonomous ? ', no driver' : ''}.</p>`);
  lines.push(`<p><strong>Cancellation:</strong> ${esc(q.provider.cancellation)}</p>`);
  lines.push(`<p><strong>Accessibility:</strong> ${esc(q.provider.accessibility)}</p>`);
  return `
    <div class="details">
      ${lines.join('')}
      <button class="secondary wide" data-act="check" data-id="${p.id}">Check live price in ${esc(handoffFor(p, q.availability, trip().pickup!, trip().dropoff!).appName)}</button>
    </div>`;
}

function renderQuotes(): void {
  const el = $('#quotes');
  const t = trip();
  if (!t.dropoff) {
    el.innerHTML = emptyState();
    return;
  }
  if (!t.pickup) {
    el.innerHTML = `<div class="empty"><p>Set a pickup to compare prices.</p><button class="primary" data-act="gps">Use my location</button></div>`;
    return;
  }
  if (S.routeLoading && !S.route) {
    el.innerHTML = Array.from({ length: 4 }, () => '<div class="card skeleton" aria-hidden="true"><span></span><span></span></div>').join('');
    return;
  }
  const now = Date.now();
  const quotes = currentQuotes();
  if (quotes.length === 0) {
    el.innerHTML = `<div class="empty"><p>No rides match these filters.</p><button class="secondary" data-act="clear-filters">Clear filters</button></div>`;
    return;
  }
  const best = quotes.reduce((a, b) => (effectivePrice(b, now) < effectivePrice(a, now) ? b : a));
  const fastest = quotes.reduce((a, b) => (b.arrivalMin < a.arrivalMin ? b : a));
  const last = lastPaidOnRoute(S.data.observations, t.pickup, t.dropoff, haversineKm);
  const history = last
    ? `<p class="note history-note">Last time on this route: <strong>${money2(last.actual)}</strong> with ${esc(last.productName)} ${/^\d|^[A-Z]/.test(shortDate(last.ts)) ? 'on ' : ''}${shortDate(last.ts)}.</p>`
    : '';
  el.innerHTML = history + quotes.map((q) => quoteCard(q, best.product.id, fastest.product.id, now)).join('');
  el.setAttribute('aria-busy', String(S.routeLoading));
}

function emptyState(): string {
  const d = S.data;
  const recents = d.recents
    .filter((r) => !findSaved(d, r))
    .slice(0, 5)
    .map(
      (p) => `
    <button class="place-row" data-act="quick-dest" data-i="${d.recents.indexOf(p)}">
      <span class="place-icon" aria-hidden="true">${ICON.recent}</span>
      <span class="place-text"><span class="place-name">${esc(p.name)}</span><span class="place-addr">${esc(p.address)}</span></span>
    </button>`,
    )
    .join('');
  const hero =
    d.saved.length || recents
      ? ''
      : `<div class="empty hero"><p class="hero-title">Every ride, one screen.</p><p>Enter a destination once to compare Uber, Lyft, and robotaxis side by side, then open your pick with the trip already filled in.</p></div>`;
  return `${hero}${savedSection('main')}${recents ? `<h2 class="section">Recent</h2>${recents}` : ''}`;
}

/** Where a saved-places list is shown: the main screen, a trip picker, or Settings. */
type SavedTarget = 'main' | 'pickup' | 'dropoff' | 'settings';

/** Home, Work, custom places and "Add a place". Rows pick the place, or edit it in Settings. */
function savedSection(target: SavedTarget): string {
  const d = S.data;
  const row = (sp: SavedPlace) => {
    const sub = sp.kind === 'other' || sp.name === sp.label ? sp.address : `${sp.name}, ${sp.address}`;
    const act = target === 'settings' ? 'edit-place' : 'use-saved';
    return `
    <div class="place-line">
      <button class="place-row" data-act="${act}" data-id="${sp.id}" data-target="${target}">
        <span class="place-icon ${sp.kind}" aria-hidden="true">${ICON[sp.kind]}</span>
        <span class="place-text"><span class="place-name">${esc(sp.label)}</span><span class="place-addr">${esc(sub)}</span></span>
      </button>
      ${target === 'settings' ? '' : `<button class="icon-btn sm" data-act="edit-place" data-id="${sp.id}" data-target="${target}" aria-label="Edit ${esc(sp.label)}">${ICON.edit}</button>`}
    </div>`;
  };
  const unset = (kind: 'home' | 'work') => `
    <button class="place-row unset" data-act="edit-place" data-kind="${kind}" data-target="${target}">
      <span class="place-icon ${kind}" aria-hidden="true">${ICON[kind]}</span>
      <span class="place-text"><span class="place-name">Set ${KIND_LABEL[kind]}</span><span class="place-addr">Add your ${KIND_LABEL[kind].toLowerCase()} address</span></span>
    </button>`;
  const fixed = (['home', 'work'] as const).map((k) => {
    const sp = savedOfKind(d, k);
    return sp ? row(sp) : unset(k);
  });
  const others = orderedSaved(d)
    .filter((sp) => sp.kind === 'other')
    .map(row);
  return `
    <h2 class="section">Saved places</h2>
    <div class="saved-list">
      ${fixed.join('')}${others.join('')}
      <button class="place-row add" data-act="edit-place" data-kind="other" data-target="${target}">
        <span class="place-icon" aria-hidden="true">${ICON.add}</span>
        <span class="place-text"><span class="place-name">Add a place</span></span>
      </button>
    </div>`;
}

/** A saved place as a trip endpoint: show its label, keep the real address. */
function savedAsPlace(sp: SavedPlace): Place {
  const address = sp.kind === 'other' || sp.name === sp.label ? sp.address : `${sp.name}, ${sp.address}`;
  return { name: sp.label, address, lat: sp.lat, lng: sp.lng };
}

function renderFooter(): void {
  const m = metro();
  const avs = (['waymo', 'zoox', 'tesla'] as const).filter((id) => availabilityIn(m, id) && S.data.settings.providerPrefs[id] !== 'hide');
  const cal = PROVIDER_ORDER.filter((id) => calibrationFor(S.data.observations, id, m?.id ?? null)).length;
  $('#footer').innerHTML = `
    <p>Prices are estimated totals including fees; the provider app shows the final price. Payment stays in each provider’s app.</p>
    <p>${m ? `${esc(m.name)}: Uber, Lyft${avs.length ? `, ${avs.map((id) => PROVIDERS[id].name).join(', ')}` : ''}.` : 'Outside robotaxi areas: Uber and Lyft.'} ${cal ? `Calibrated with your prices for ${cal} provider${cal === 1 ? '' : 's'}.` : 'Log real prices to calibrate.'}</p>
    ${S.notice ? `<p class="error" role="alert">${esc(S.notice)}</p>` : ''}`;
}

// ---------------------------------------------------------------- sheets

const sheetRoot = () => $('#sheet');
let sheetCleanup: (() => void) | null = null;

function openSheet(html: string, opts: { full?: boolean; label: string }): HTMLElement {
  closeSheet();
  const root = sheetRoot();
  root.innerHTML = `
    <div class="scrim" data-act="close-sheet"></div>
    <section class="sheet ${opts.full ? 'full' : ''}" role="dialog" aria-modal="true" aria-label="${esc(opts.label)}">
      ${opts.full ? '' : '<div class="grabber" aria-hidden="true"></div>'}
      ${html}
    </section>`;
  root.hidden = false;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => root.classList.add('shown'));
  return $('.sheet', root);
}

function closeSheet(): void {
  sheetCleanup?.();
  sheetCleanup = null;
  const root = sheetRoot();
  root.classList.remove('shown');
  root.hidden = true;
  root.innerHTML = '';
  document.body.classList.remove('sheet-open');
}

// Place picker --------------------------------------------------------------

let pickerResults: Place[] = [];

type PickerMode = 'pickup' | 'dropoff' | 'save';

function openPicker(which: PickerMode): void {
  const d = S.data;
  const saving = which === 'save';
  const back = saving ? 'back-to-editor' : 'close-sheet';
  const simple = (act: string, icon: string, label: string) =>
    `<button class="place-row" data-act="${act}"><span class="place-icon" aria-hidden="true">${icon}</span><span class="place-text"><span class="place-name">${label}</span></span></button>`;
  const recentRow = (p: Place, i: number) => `
    <button class="place-row" data-act="picker-recent" data-i="${i}">
      <span class="place-icon" aria-hidden="true">${ICON.recent}</span>
      <span class="place-text"><span class="place-name">${esc(p.name)}</span><span class="place-addr">${esc(p.address)}</span></span>
    </button>`;
  const placeholder = which === 'pickup' ? 'Pickup location' : saving ? 'Search for an address' : 'Where to?';
  const sheet = openSheet(
    `<header class="sheet-head">
      <button class="icon-btn" data-act="${back}" aria-label="Back">‹</button>
      <input class="search" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"
        placeholder="${placeholder}" aria-label="${placeholder}">
    </header>
    <div class="sheet-body" data-which="${which}">
      <div class="results" aria-live="polite"></div>
      <div class="defaults">
        ${which !== 'dropoff' ? simple('picker-gps', ICON.locate, 'Current location') : ''}
        ${simple('picker-map', ICON.map, 'Choose on map')}
        ${saving ? '' : savedSection(which)}
        ${d.recents.length ? `<h2 class="section">Recent</h2>${d.recents.map(recentRow).join('')}` : ''}
      </div>
    </div>`,
    { full: true, label: saving ? 'Choose address' : which === 'pickup' ? 'Choose pickup' : 'Choose destination' },
  );
  const input = $<HTMLInputElement>('.search', sheet);
  const results = $('.results', sheet);
  const defaults = $('.defaults', sheet);
  let timer = 0;
  let ctrl: AbortController | null = null;
  pickerResults = [];
  const run = async () => {
    const qtext = input.value.trim();
    ctrl?.abort();
    if (qtext.length < 2) {
      results.innerHTML = '';
      defaults.hidden = false;
      return;
    }
    defaults.hidden = true;
    ctrl = new AbortController();
    const near = trip().pickup ?? null;
    try {
      pickerResults = await searchPlaces(qtext, near, ctrl.signal);
      results.innerHTML = pickerResults.length
        ? pickerResults
            .map(
              (p, i) => `
          <div class="place-line">
            <button class="place-row" data-act="picker-result" data-i="${i}">
              <span class="place-icon" aria-hidden="true">${ICON.search}</span>
              <span class="place-text"><span class="place-name">${esc(p.name)}</span><span class="place-addr">${esc(p.address)}</span></span>
            </button>
            ${
              saving
                ? ''
                : `<button class="star ${findSaved(S.data, p) ? 'on' : ''}" data-act="picker-star" data-i="${i}" aria-label="${findSaved(S.data, p) ? 'Edit saved place' : 'Save'} ${esc(p.name)}">${findSaved(S.data, p) ? '★' : '☆'}</button>`
            }
          </div>`,
            )
            .join('')
        : '<p class="note pad">No matches. Try adding a city.</p>';
    } catch (e) {
      if ((e as Error).name !== 'AbortError') results.innerHTML = '<p class="note pad">Search is unavailable right now. Check your connection.</p>';
    }
  };
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, 280);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && pickerResults[0]) {
      e.preventDefault();
      choose(which, pickerResults[0]);
    }
  });
  sheetCleanup = () => {
    window.clearTimeout(timer);
    ctrl?.abort();
  };
  input.focus();
}

function choose(which: PickerMode, p: Place): void {
  if (which === 'save') {
    if (editing) editing.place = p;
    return openPlaceEditor();
  }
  closeSheet();
  setPlace(which, p);
}

function openMapPicker(which: PickerMode): void {
  const t = trip();
  const start = which === 'save' ? editing?.place : which === 'pickup' ? t.pickup : t.dropoff;
  const center = start ?? t.pickup ?? { lat: 37.7749, lng: -122.4194 };
  const sheet = openSheet(
    `<header class="sheet-head">
      <button class="icon-btn" data-act="${which === 'save' ? 'back-to-editor' : 'close-sheet'}" aria-label="Back">‹</button>
      <h2 class="sheet-title">Drag the map to set ${which === 'pickup' ? 'pickup' : which === 'save' ? 'the address' : 'destination'}</h2>
    </header>
    <div class="pick-map"><div class="pick-map-canvas"></div><span class="center-pin ${which === 'pickup' ? 'pickup' : 'dropoff'}" aria-hidden="true"></span></div>
    <div class="sheet-actions"><button class="primary wide" data-act="map-confirm" data-which="${which}">Use this spot</button></div>`,
    { full: true, label: 'Choose on map' },
  );
  const picker = pickOnMap($('.pick-map-canvas', sheet), center);
  mapPickerCenter = picker.getCenter;
  sheetCleanup = () => {
    picker.map.remove();
    mapPickerCenter = null;
  };
}

let mapPickerCenter: (() => { lat: number; lng: number }) | null = null;

// Saved place editor -----------------------------------------------------------

interface Editing {
  id: string;
  isNew: boolean;
  kind: PlaceKind;
  label: string;
  place: Place | null;
  /** Where to go after saving: use the place for the trip, or back to Settings. */
  target: SavedTarget | null;
}

let editing: Editing | null = null;

function startEdit(opts: { id?: string; kind?: PlaceKind; place?: Place; target?: SavedTarget | null }): void {
  const existing = opts.id ? S.data.saved.find((s) => s.id === opts.id) : opts.place ? findSaved(S.data, opts.place) : undefined;
  if (existing) {
    const { id, kind, label, name, address, lat, lng } = existing;
    editing = { id, isNew: false, kind, label: kind === 'other' ? label : '', place: { name, address, lat, lng }, target: opts.target ?? null };
  } else {
    const kind = opts.kind ?? 'other';
    // Home/Work already set? Edit that one rather than making a second.
    const current = kind !== 'other' ? savedOfKind(S.data, kind) : undefined;
    if (current) return startEdit({ id: current.id, target: opts.target });
    editing = { id: newId(), isNew: true, kind, label: opts.place && kind === 'other' ? opts.place.name : '', place: opts.place ?? null, target: opts.target ?? null };
  }
  openPlaceEditor();
}

function openPlaceEditor(): void {
  if (!editing) return;
  openSheet(
    `<header class="sheet-head">
      <button class="icon-btn" data-act="editor-cancel" aria-label="Back">‹</button>
      <h2 class="sheet-title">${editing.isNew ? 'Save a place' : 'Edit place'}</h2>
    </header>
    <div class="sheet-body editor"></div>`,
    { full: true, label: editing.isNew ? 'Save a place' : 'Edit place' },
  );
  renderEditor(editing.kind === 'other' && !editing.label);
}

function renderEditor(focusLabel = false): void {
  const e = editing;
  const body = document.querySelector<HTMLElement>('.editor');
  if (!e || !body) return;
  const kindBtn = (k: PlaceKind, label: string) =>
    `<button class="${e.kind === k ? 'on' : ''}" aria-pressed="${e.kind === k}" data-act="edit-kind" data-v="${k}">${ICON[k]}<span>${label}</span></button>`;
  const clash = e.kind !== 'other' ? savedOfKind(S.data, e.kind) : undefined;
  const replaces = clash && clash.id !== e.id ? `<p class="note">This replaces your current ${KIND_LABEL[e.kind as 'home' | 'work']} (${esc(clash.name)}).</p>` : '';
  const canSave = !!e.place && (e.kind !== 'other' || e.label.trim().length > 0);
  body.innerHTML = `
    <h2 class="section">Type</h2>
    <div class="seg kind-seg" role="group" aria-label="Place type">${kindBtn('home', 'Home')}${kindBtn('work', 'Work')}${kindBtn('other', 'Other')}</div>
    ${replaces}
    ${
      e.kind === 'other'
        ? `<h2 class="section">Label</h2>
           <input class="text-input" type="text" data-input="edit-label" value="${esc(e.label)}" placeholder="e.g. Gym, Mom’s, Airport" maxlength="40" aria-label="Label" autocapitalize="words">`
        : ''
    }
    <h2 class="section">Address</h2>
    <button class="place-row boxed" data-act="edit-address">
      <span class="place-icon" aria-hidden="true">${ICON.other}</span>
      <span class="place-text">${
        e.place
          ? `<span class="place-name">${esc(e.place.name)}</span><span class="place-addr">${esc(e.place.address)}</span>`
          : '<span class="place-name placeholder">Choose an address</span>'
      }</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="primary wide big" data-act="save-place" ${canSave ? '' : 'disabled'}>Save</button>
    ${e.isNew ? '' : '<button class="secondary wide danger" data-act="delete-place">Delete place</button>'}`;
  if (focusLabel) body.querySelector<HTMLInputElement>('[data-input="edit-label"]')?.focus();
}

function finishEdit(saved: SavedPlace | null): void {
  const target = editing?.target ?? null;
  const wasNew = editing?.isNew ?? false;
  editing = null;
  closeSheet();
  renderQuotes();
  if (target === 'settings') return openSettings();
  // A place added while choosing a trip endpoint is used right away.
  if (saved && wasNew && (target === 'pickup' || target === 'dropoff')) return setPlace(target, savedAsPlace(saved));
}

function savePlace(): void {
  const e = editing;
  if (!e?.place) return;
  const sp: SavedPlace = { ...e.place, id: e.id, kind: e.kind, label: e.label };
  upsertSaved(S.data, sp);
  persist();
  const stored = S.data.saved.find((x) => x.id === e.id)!;
  toast(`Saved ${stored.label}.`);
  finishEdit(stored);
}

// Book / check ---------------------------------------------------------------

function findQuote(id: string): Quote | undefined {
  return currentQuotes().find((q) => q.product.id === id);
}

function openBook(id: string): void {
  const q = findQuote(id);
  const t = trip();
  if (!q || !t.pickup || !t.dropoff) return;
  const h = handoffFor(q.product, q.availability, t.pickup, t.dropoff);
  const now = Date.now();
  const live = q.checked && now - q.checked.ts < CHECK_TTL_MS ? q.checked : null;
  openSheet(
    `<div class="confirm">
      <div class="confirm-head">
        <span class="mono" style="background:${q.provider.color};color:${q.provider.onColor}" aria-hidden="true">${q.provider.monogram}</span>
        <div><h2>${esc(q.product.name)}</h2><p class="muted">Booked via ${esc(h.appName)}</p></div>
        <div class="confirm-price">${live ? money2(live.price) : money(q.mid)}<span class="muted small">${live ? 'live price' : 'estimated total'}</span></div>
      </div>
      <dl class="confirm-list">
        <div><dt>Pickup</dt><dd>${esc(t.pickup.name)}<span class="muted small">${esc(t.pickup.address)}</span></dd></div>
        <div><dt>Drop-off</dt><dd>${esc(t.dropoff.name)}<span class="muted small">${esc(t.dropoff.address)}</span></dd></div>
        <div><dt>Payment</dt><dd>The card saved in your ${esc(h.appName)} app</dd></div>
      </dl>
      <p class="note">${
        h.prefilled
          ? `${esc(h.appName)} opens with your pickup and drop-off filled in. Confirm the final price there and tap request.`
          : `${esc(h.appName)} has no trip link, so we’ll copy the destination address — paste it in the app.`
      }</p>
      <button class="primary wide big" data-act="go" data-mode="book" data-id="${q.product.id}">Open ${esc(h.appName)} to book</button>
      <button class="secondary wide" data-act="close-sheet">Cancel</button>
    </div>`,
    { label: `Book ${q.product.name}` },
  );
}

function go(id: string, mode: 'book' | 'check'): void {
  const q = findQuote(id);
  const t = trip();
  if (!q || !t.pickup || !t.dropoff) return;
  const now = Date.now();
  // Savings are measured against the priciest comparable ride (same class),
  // not against e.g. Uber Black when you booked an UberX.
  const peers = currentQuotes().filter((x) => x.product.tier === q.product.tier);
  const highest = Math.max(...peers.map((x) => effectivePrice(x, now)));
  S.data.pending = { ts: now, mode, productId: id, highestShown: highest };
  persist();
  closeSheet();
  launch(handoffFor(q.product, q.availability, t.pickup, t.dropoff), t.dropoff);
}

/** After returning from a provider app, ask what the price was. */
function maybeAskForPrice(): void {
  const p = S.data.pending;
  if (!p || !sheetRoot().hidden) return;
  if (Date.now() - p.ts > 45 * 60 * 1000) {
    S.data.pending = null;
    persist();
    return;
  }
  const q = findQuote(p.productId);
  if (!q) return;
  const app = handoffFor(q.product, q.availability, trip().pickup!, trip().dropoff!).appName;
  const book = p.mode === 'book';
  const sheet = openSheet(
    `<form class="confirm" data-form="log">
      <h2>${book ? `Did you book with ${esc(app)}?` : `What did ${esc(app)} show?`}</h2>
      <p class="muted">${
        book
          ? `Log what you paid for ${esc(q.product.name)} to track savings and sharpen future estimates.`
          : `Enter the price for ${esc(q.product.name)} — it replaces the estimate on this screen.`
      }</p>
      <label class="money-input"><span>$</span><input name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Price in dollars" required></label>
      <button class="primary wide big" type="submit">${book ? 'Save ride' : 'Save price'}</button>
      ${book ? '<button class="secondary wide" type="button" data-act="log-checked">I only checked the price</button>' : ''}
      <button class="secondary wide" type="button" data-act="log-skip">${book ? 'Didn’t book' : 'Skip'}</button>
    </form>`,
    { label: 'Log price' },
  );
  const input = $<HTMLInputElement>('input', sheet);
  input.focus();
  $('form', sheet).addEventListener('submit', (e) => {
    e.preventDefault();
    logPrice(input.value, book ? 'paid' : 'checked');
  });
  sheet.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[data-act="log-checked"]');
    if (t) logPrice(input.value, 'checked');
  });
}

function logPrice(raw: string, kind: Observation['kind']): void {
  const amount = Number.parseFloat(raw.replace(/[^0-9.]/g, ''));
  const p = S.data.pending;
  const t = trip();
  if (!p || !t.pickup || !t.dropoff) return closeSheet();
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) {
    $<HTMLInputElement>('.money-input input').setCustomValidity('Enter a price like 18.50');
    $<HTMLInputElement>('.money-input input').reportValidity();
    return;
  }
  const q = findQuote(p.productId);
  if (q) {
    S.data.observations.push({
      id: uid(),
      ts: Date.now(),
      kind,
      providerId: q.provider.id,
      productId: q.product.id,
      productName: q.product.name,
      metroId: metro()?.id ?? null,
      rawEstimate: q.rawEstimate,
      actual: amount,
      highestShown: kind === 'paid' ? p.highestShown : undefined,
      pickup: t.pickup,
      dropoff: t.dropoff,
    });
  }
  S.data.pending = null;
  if (kind === 'paid') {
    const saved = p.highestShown - amount;
    toast(saved > 0.5 ? `Ride logged — ${money(saved)} less than the priciest similar ride.` : 'Ride logged.');
    t.dropoff = null;
    t.checked = {};
    S.route = null;
  } else {
    t.checked[p.productId] = { price: amount, ts: Date.now() };
    toast('Live price saved.');
  }
  persist();
  closeSheet();
  renderAll();
}

// History ---------------------------------------------------------------------

function openHistory(): void {
  const obs = [...S.data.observations].sort((a, b) => b.ts - a.ts);
  const paid = obs.filter((o) => o.kind === 'paid');
  const savings = paid.map((o) => Math.max(0, (o.highestShown ?? o.actual) - o.actual));
  const total = savings.reduce((a, b) => a + b, 0);
  const spent = paid.reduce((a, o) => a + o.actual, 0);
  const row = (o: Observation) => {
    const prov = PROVIDERS[o.providerId];
    const save = o.kind === 'paid' && o.highestShown && o.highestShown - o.actual > 0.5 ? `<span class="saved">saved ${money(o.highestShown - o.actual)}</span>` : '';
    return `
      <li class="hist">
        <span class="mono sm" style="background:${prov.color};color:${prov.onColor}" aria-hidden="true">${prov.monogram}</span>
        <span class="hist-body">
          <span class="hist-title">${esc(o.productName)} · ${money2(o.actual)} ${o.kind === 'checked' ? '<span class="muted small">(checked)</span>' : ''}</span>
          <span class="muted small">${esc(o.pickup.name)} → ${esc(o.dropoff.name)} · ${shortDate(o.ts)}</span>
        </span>
        ${save}
        <button class="icon-btn sm" data-act="del-obs" data-id="${o.id}" aria-label="Delete this entry">✕</button>
      </li>`;
  };
  openSheet(
    `<header class="sheet-head">
      <button class="icon-btn" data-act="close-sheet" aria-label="Back">‹</button>
      <h2 class="sheet-title">Rides &amp; prices</h2>
    </header>
    <div class="sheet-body">
      <div class="stats">
        <div><span class="stat">${paid.length}</span><span class="muted small">rides</span></div>
        <div><span class="stat">${money(spent)}</span><span class="muted small">spent</span></div>
        <div><span class="stat good">${money(total)}</span><span class="muted small">saved vs priciest similar</span></div>
      </div>
      ${obs.length ? `<ul class="hist-list">${obs.map(row).join('')}</ul>` : '<p class="note pad">Nothing yet. After you book or check a price, you’ll be asked what the app charged — those entries show up here and calibrate your estimates.</p>'}
    </div>`,
    { full: true, label: 'Ride history' },
  );
}

// Settings --------------------------------------------------------------------

function openSettings(): void {
  const st = S.data.settings;
  const m = metro();
  const provRow = (id: (typeof PROVIDER_ORDER)[number]) => {
    const p = PROVIDERS[id];
    const a = availabilityIn(m, id);
    const status = a === 'full' ? 'Available here' : a === 'limited' ? 'Limited here' : a === 'via-uber' ? 'Via Uber here' : 'Not in this area';
    const cal = calibrationFor(S.data.observations, id, m?.id ?? null);
    const pref = st.providerPrefs[id];
    const opt = (v: ProviderPref, label: string) =>
      `<button class="${pref === v ? 'on' : ''}" aria-pressed="${pref === v}" data-act="pref" data-id="${id}" data-v="${v}">${label}</button>`;
    return `
      <li class="set-row">
        <span class="mono sm" style="background:${p.color};color:${p.onColor}" aria-hidden="true">${p.monogram}</span>
        <span class="set-body"><span>${esc(p.name)}</span><span class="muted small">${status}${cal ? ` · ×${cal.factor.toFixed(2)} from ${cal.samples} price${cal.samples === 1 ? '' : 's'}` : ''}</span></span>
        <span class="seg sm">${opt('auto', 'Auto')}${opt('always', 'On')}${opt('hide', 'Off')}</span>
      </li>`;
  };
  openSheet(
    `<header class="sheet-head">
      <button class="icon-btn" data-act="close-sheet" aria-label="Back">‹</button>
      <h2 class="sheet-title">Settings</h2>
    </header>
    <div class="sheet-body">
      <h2 class="section">Providers</h2>
      <p class="note">Auto shows robotaxis only where they operate${m ? ` (you’re in ${esc(m.name)})` : ''}. Coverage changes often — force a provider On or Off if this is wrong.</p>
      <ul class="set-list">${PROVIDER_ORDER.map(provRow).join('')}</ul>

      <h2 class="section">Best value</h2>
      <label class="set-row col">
        <span>Your time is worth <strong data-out="vot">${money(st.valueOfTime * 60)}/hour</strong></span>
        <input type="range" min="0" max="1.5" step="0.05" value="${st.valueOfTime}" data-input="vot" aria-label="Value of time, dollars per minute">
        <span class="muted small">“Best value” ranks rides by price + this × minutes until you arrive.</span>
      </label>

      <h2 class="section">Busy times</h2>
      <label class="set-row toggle">
        <span class="set-body"><span>Adjust for busy hours</span><span class="muted small">Weekday commutes and Fri/Sat nights: +10% for Uber/Lyft, wider ranges, longer drive times.</span></span>
        <input type="checkbox" ${st.peakAdjust ? 'checked' : ''} data-input="peak">
      </label>

      ${savedSection('settings')}

      <h2 class="section">Your data</h2>
      <p class="note">Everything is stored only on this phone. Place searches go to Photon (komoot) and routes to the OSRM demo server, both OpenStreetMap services; map tiles come from OpenStreetMap.</p>
      <div class="set-actions">
        <button class="secondary" data-act="export">Export JSON</button>
        <button class="secondary danger" data-act="wipe">Delete all data</button>
      </div>

      <h2 class="section">About estimates</h2>
      <p class="note">Uber, Lyft and the robotaxi companies don’t offer price APIs to individuals, so prices here are estimates from typical rates. Use “Check live price” to see the real one, then log it — after a few logged prices the estimates track what you actually see. Not affiliated with any provider.</p>
    </div>`,
    { full: true, label: 'Settings' },
  );
}

function exportData(): void {
  const blob = new Blob([JSON.stringify(S.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fareview-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Toast -----------------------------------------------------------------------

let toastTimer = 0;
function toast(msg: string): void {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3500);
}

// ---------------------------------------------------------------- events

function onClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  const act = el.dataset.act!;
  const id = el.dataset.id ?? '';
  const i = Number(el.dataset.i);
  const which = (el.closest<HTMLElement>('[data-which]')?.dataset.which ?? el.dataset.which) as PickerMode;
  switch (act) {
    case 'pick':
      return openPicker(el.dataset.which as 'pickup' | 'dropoff');
    case 'swap':
      return swap();
    case 'gps':
      return void useGps();
    case 'requote':
      if (trip().pickupIsGps) return void useGps();
      return void requote();
    case 'sort':
      S.data.sort = el.dataset.sort as SortKey;
      persist();
      renderControls();
      return renderQuotes();
    case 'toggle-filters':
      S.showFilters = !S.showFilters;
      return renderControls();
    case 'filter': {
      const k = el.dataset.key as 'xl' | 'premium' | 'autonomous';
      S.filters[k] = !S.filters[k];
      renderControls();
      return renderQuotes();
    }
    case 'clear-filters':
      S.filters = { xl: false, premium: false, autonomous: false, maxPrice: null };
      renderControls();
      return renderQuotes();
    case 'expand':
      S.expanded = S.expanded === id ? null : id;
      return renderQuotes();
    case 'book':
      return openBook(id);
    case 'check':
      return go(id, 'check');
    case 'go':
      return go(id, el.dataset.mode as 'book' | 'check');
    case 'close-sheet':
      return closeSheet();
    case 'quick-dest': {
      const p = S.data.recents[i];
      if (p) setPlace('dropoff', p);
      return;
    }
    case 'use-saved': {
      const sp = S.data.saved.find((x) => x.id === id);
      if (!sp) return;
      closeSheet();
      return setPlace(el.dataset.target === 'pickup' ? 'pickup' : 'dropoff', savedAsPlace(sp));
    }
    case 'edit-place':
      return startEdit({ id: id || undefined, kind: el.dataset.kind as PlaceKind | undefined, target: (el.dataset.target as SavedTarget) ?? null });
    case 'edit-kind':
      if (!editing) return;
      editing.kind = el.dataset.v as PlaceKind;
      return renderEditor(editing.kind === 'other');
    case 'edit-address':
      return openPicker('save');
    case 'back-to-editor':
      return openPlaceEditor();
    case 'editor-cancel':
      return finishEdit(null);
    case 'save-place':
      return savePlace();
    case 'delete-place': {
      if (!editing) return;
      const label = editing.kind === 'other' ? editing.label : KIND_LABEL[editing.kind];
      if (!window.confirm(`Delete “${label}” from saved places?`)) return;
      removeSaved(S.data, editing.id);
      persist();
      return finishEdit(null);
    }
    case 'picker-gps':
      if (which === 'save') {
        el.querySelector('.place-name')!.textContent = 'Finding you…';
        void currentPosition()
          .then((pos) => reverseGeocode(pos.lat, pos.lng))
          .then((p) => choose('save', p))
          .catch((err: Error) => toast(err.message));
        return;
      }
      closeSheet();
      return void useGps();
    case 'picker-map':
      return openMapPicker(which);
    case 'picker-result':
      return choose(which, pickerResults[i]);
    case 'picker-recent':
      return choose(which, S.data.recents[i]);
    case 'picker-star': {
      const p = pickerResults[i];
      if (p) startEdit({ place: p, target: which === 'save' ? null : which });
      return;
    }
    case 'map-confirm': {
      const c = mapPickerCenter?.();
      if (!c) return;
      el.setAttribute('disabled', '');
      el.textContent = 'Finding address…';
      void reverseGeocode(c.lat, c.lng).then((p) => choose(which, p));
      return;
    }
    case 'log-skip':
      S.data.pending = null;
      persist();
      return closeSheet();
    case 'history':
      return openHistory();
    case 'settings':
      return openSettings();
    case 'del-obs':
      S.data.observations = S.data.observations.filter((o) => o.id !== id);
      persist();
      renderAll();
      return openHistory();
    case 'pref':
      S.data.settings.providerPrefs[id as keyof typeof PROVIDERS] = el.dataset.v as ProviderPref;
      persist();
      renderAll();
      return openSettings();
    case 'export':
      return exportData();
    case 'wipe':
      if (!window.confirm('Delete saved places, history, calibration and settings from this phone? This can’t be undone.')) return;
      clearAll();
      S.data = load();
      S.route = null;
      closeSheet();
      renderAll();
      return toast('All data deleted.');
  }
}

function onInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  switch (el.dataset.input) {
    case 'maxprice': {
      const v = Number.parseFloat(el.value);
      S.filters.maxPrice = Number.isFinite(v) && v > 0 ? v : null;
      el.closest('.chip')?.classList.toggle('on', S.filters.maxPrice != null);
      return renderQuotes();
    }
    case 'vot': {
      S.data.settings.valueOfTime = Number(el.value);
      persist();
      const out = $('[data-out="vot"]');
      if (out) out.textContent = `${money(S.data.settings.valueOfTime * 60)}/hour`;
      return renderQuotes();
    }
    case 'edit-label': {
      if (!editing) return;
      editing.label = el.value;
      const btn = document.querySelector<HTMLButtonElement>('[data-act="save-place"]');
      if (btn) btn.disabled = !editing.place || !editing.label.trim();
      return;
    }
    case 'peak':
      S.data.settings.peakAdjust = el.checked;
      persist();
      return void requote();
  }
}

// ---------------------------------------------------------------- boot

export function start(): void {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheetRoot().hidden) closeSheet();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderQuotes();
    maybeAskForPrice();
  });
  // Re-render periodically so "Live · 3m ago" and stale markers stay honest.
  window.setInterval(() => {
    if (document.visibilityState === 'visible' && trip().dropoff) {
      renderSummary();
      renderQuotes();
    }
  }, 30000);

  renderAll();
  const t = trip();
  if (t.pickup && t.dropoff) void requote();
  if (!t.pickup || t.pickupIsGps) void useGps();
}

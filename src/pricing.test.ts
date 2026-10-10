import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffFor } from './handoff.ts';
import { applyFilters, buildQuotes, calibrationFor, isPeak, rawFare, sortQuotes } from './pricing.ts';
import { PROVIDERS, findMetro } from './providers.ts';
import type { Observation, Place, Route, Settings } from './types.ts';

const route: Route = { distanceMi: 4, durationMin: 16, approximate: false };
const settings: Settings = {
  providerPrefs: { uber: 'auto', lyft: 'auto', waymo: 'auto', zoox: 'auto', tesla: 'auto' },
  valueOfTime: 0.3,
  peakAdjust: true,
};
const offPeak = new Date('2026-10-07T13:00:00'); // Wednesday afternoon
const A: Place = { name: 'Ferry Building', address: 'San Francisco', lat: 37.7955, lng: -122.3937 };
const B: Place = { name: 'Mission Dolores', address: 'San Francisco', lat: 37.7644, lng: -122.4269 };

function obs(providerId: Observation['providerId'], raw: number, actual: number, metroId = 'sf'): Observation {
  return {
    id: Math.random().toString(),
    ts: Date.now(),
    kind: 'paid',
    providerId,
    productId: `${providerId}-x`,
    productName: 'X',
    metroId,
    rawEstimate: raw,
    actual,
    pickup: A,
    dropoff: B,
  };
}

test('default rate cards land near published SF averages for a 4 mi trip', () => {
  const fare = (id: keyof typeof PROVIDERS) => rawFare(PROVIDERS[id].products[0], route);
  assert.ok(Math.abs(fare('uber') - 17) < 1.5, `uber ${fare('uber')}`);
  assert.ok(Math.abs(fare('lyft') - 15.5) < 1.5, `lyft ${fare('lyft')}`);
  assert.ok(Math.abs(fare('waymo') - 19.7) < 1.5, `waymo ${fare('waymo')}`);
  assert.ok(fare('tesla') < 10);
});

test('minimum fare applies to very short trips', () => {
  const short: Route = { distanceMi: 0.3, durationMin: 2, approximate: false };
  const x = PROVIDERS.uber.products[0];
  assert.equal(rawFare(x, short), x.rate.minFare + x.rate.fee);
});

test('peak windows', () => {
  assert.equal(isPeak(new Date('2026-10-07T08:00:00')), true); // Wed 8am
  assert.equal(isPeak(new Date('2026-10-07T13:00:00')), false);
  assert.equal(isPeak(new Date('2026-10-10T23:30:00')), true); // Sat 11:30pm
  assert.equal(isPeak(new Date('2026-10-11T01:00:00')), true); // Sun 1am
  assert.equal(isPeak(new Date('2026-10-11T08:00:00')), false); // Sun 8am
});

test('metro lookup picks the nearest covering metro', () => {
  assert.equal(findMetro(37.79, -122.4)?.id, 'sf');
  assert.equal(findMetro(30.27, -97.74)?.id, 'aus');
  assert.equal(findMetro(40.71, -74.0), null); // NYC: Uber/Lyft only
});

test('robotaxis only appear where they operate unless forced on', () => {
  const ids = (lat: number, lng: number, s = settings) =>
    new Set(
      buildQuotes({ route, metro: findMetro(lat, lng), settings: s, observations: [], checked: {}, now: offPeak }).map((q) => q.provider.id),
    );
  assert.deepEqual([...ids(37.79, -122.4)].sort(), ['lyft', 'tesla', 'uber', 'waymo', 'zoox']);
  assert.deepEqual([...ids(40.71, -74.0)].sort(), ['lyft', 'uber']);
  const forced = { ...settings, providerPrefs: { ...settings.providerPrefs, waymo: 'always' as const, uber: 'hide' as const } };
  assert.deepEqual([...ids(40.71, -74.0, forced)].sort(), ['lyft', 'waymo']);
});

test('calibration uses the median ratio and prefers the local metro', () => {
  const o = [obs('uber', 10, 12), obs('uber', 10, 14), obs('uber', 10, 30), obs('uber', 10, 5, 'la')];
  const c = calibrationFor(o, 'uber', 'sf')!;
  assert.equal(c.samples, 3);
  assert.equal(c.factor, 1.4);
  assert.equal(calibrationFor(o, 'lyft', 'sf'), null);
  // Only one local sample: fall back to all of them.
  assert.equal(calibrationFor([obs('lyft', 10, 20), obs('lyft', 10, 10, 'la')], 'lyft', 'sf')!.samples, 2);
});

test('calibration scales the estimate', () => {
  const base = buildQuotes({ route, metro: null, settings, observations: [], checked: {}, now: offPeak });
  const cal = buildQuotes({ route, metro: null, settings, observations: [obs('uber', 10, 15, '')], checked: {}, now: offPeak });
  const x = (qs: typeof base) => qs.find((q) => q.product.id === 'uber-x')!.mid;
  assert.ok(Math.abs(x(cal) / x(base) - 1.5) < 1e-9);
});

test('a checked live price overrides the estimate for sorting', () => {
  const now = offPeak.getTime();
  const qs = buildQuotes({ route, metro: null, settings, observations: [], checked: { 'uber-black': { price: 1, ts: now } }, now: offPeak });
  assert.equal(sortQuotes(qs, 'price', 0.3, now)[0].product.id, 'uber-black');
  // …but not once it has expired.
  assert.notEqual(sortQuotes(qs, 'price', 0.3, now + 60 * 60 * 1000)[0].product.id, 'uber-black');
});

test('filters', () => {
  const now = offPeak.getTime();
  const qs = buildQuotes({ route, metro: findMetro(37.79, -122.4), settings, observations: [], checked: {}, now: offPeak });
  assert.ok(applyFilters(qs, { xl: true, premium: false, autonomous: false, maxPrice: null }, now).every((q) => q.product.seats >= 6));
  assert.ok(applyFilters(qs, { xl: false, premium: false, autonomous: true, maxPrice: null }, now).every((q) => q.provider.autonomous));
  assert.ok(applyFilters(qs, { xl: false, premium: false, autonomous: false, maxPrice: 16 }, now).every((q) => q.mid <= 16));
});

test('handoff links prefill Uber and Lyft, route Waymo-in-Austin via Uber', () => {
  const uber = handoffFor(PROVIDERS.uber.products[0], 'full', A, B);
  assert.ok(uber.primary.startsWith('uber://?action=setPickup'));
  assert.ok(uber.primary.includes('dropoff[latitude]=37.764400'));
  assert.ok(uber.fallback.startsWith('https://m.uber.com/ul/'));
  const lyftXl = handoffFor(PROVIDERS.lyft.products[2], 'full', A, B);
  assert.ok(lyftXl.primary.startsWith('lyft://ridetype?id=lyft_plus'));
  assert.equal(handoffFor(PROVIDERS.waymo.products[0], 'via-uber', A, B).appName, 'Uber');
  const waymo = handoffFor(PROVIDERS.waymo.products[0], 'full', A, B);
  assert.equal(waymo.prefilled, false);
  assert.ok(waymo.fallback.includes('id1343524838'));
});

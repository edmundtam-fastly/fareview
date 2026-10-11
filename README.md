# Fareview

Compare Uber, Lyft, Waymo, Zoox and Tesla Robotaxi on one screen, then open the app you pick with the trip filled in. This is a personal MVP of the *Rideshare Price Comparison App* PRD (v0.1). It's a home-screen web app, so it doesn't need the App Store.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # pricing / coverage / deep-link unit tests
npm run build    # production build in dist/
```

## Put it on your iPhone

1. Deploy it (pushing to `main` runs `.github/workflows/deploy.yml`, which publishes to GitHub Pages at `https://<user>.github.io/fareview/`). In the repo, set **Settings → Pages → Source** to **GitHub Actions**.
2. On the iPhone, open that URL in **Safari** → Share → **Add to Home Screen**.
3. Open it from the home screen and allow location when asked.

## How it works

The PRD assumes partner APIs. Uber, Lyft and the robotaxi companies don't give individuals access to quote or booking APIs, so the MVP works like this:

| PRD | What Fareview does |
|---|---|
| FR-01 pickup/dropoff, GPS, saved, recent, map pin | ✅ GPS pickup, OpenStreetMap search (Photon), Home / Work / custom-labelled saved places (add, rename, re-address, delete), recents, “Choose on map” |
| FR-02 parallel quotes | ⚠️ **Estimates.** Real route distance and time (OSRM) × per-provider rate cards, shown as a range. Robotaxis appear only in metros where they run |
| FR-03/04 one-screen compare, sort, badges | ✅ Price / ETA / Best value (your $/hour is set in Settings), Best price + Fastest badges, filters (XL, comfort/premium, autonomous, max $) |
| FR-05/06 in-app booking with stored payment | ↪️ **Hand-off.** Book → confirm sheet → opens Uber/Lyft with pickup and drop-off filled in, and payment stays in that app. Waymo/Zoox/Tesla have no trip link, so the destination is copied and the app opens through the App Store. Waymo in Austin/Atlanta goes through Uber |
| FR-07 tracking & receipts | ↪️ Tracking happens in the provider app. When you come back, Fareview asks what you paid and logs it to **Rides & prices** with savings |
| FR-08 deep-link fallback | ✅ This is the main booking path |
| P1 stale-quote timer, history | ✅ “Updated 1:29 PM ↻”, history across providers |
| §7 price context and personal history | ✅ Each card's “Why this price” note, “Last time on this route: $X”, busy-hours notice (no spoofing of any kind) |

### Making the estimates accurate

Tap a card → **Check live price in Uber**. The app opens with the trip filled in. Come back and type the price you saw, and it replaces the estimate on screen (marked “Live”, and flagged as stale after 5 minutes). Each logged price also calibrates that provider (median of actual ÷ estimate, per metro when there's enough data). After a few rides the estimates track your real prices.

### Where things live

- `src/providers.ts`: rate cards, metro coverage (Oct 2026 press reports), App Store ids. Edit these when prices or coverage change.
- `src/pricing.ts`: estimate, calibration, busy hours, sort/filter logic (unit-tested).
- `src/handoff.ts`: deep links for each provider.
- `src/geo.ts`: Photon search, reverse geocoding, OSRM routing (with a straight-line fallback).
- `src/app.ts`: UI. `src/store.ts`: localStorage (everything stays on the phone).

### Known limits

- Prices are estimates until you check one. Surge isn't knowable without provider APIs, so busy hours only widen the range.
- Uber/Lyft deep-link formats are the published ones, and Waymo/Zoox/Tesla open via the App Store. Test each on your phone once.
- Photon and the OSRM demo server are free community services meant for light personal use.
- Not affiliated with any provider. Provider names are used only to identify the service.

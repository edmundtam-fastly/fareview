import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Place, Route } from './types.ts';

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

function dot(cls: string): L.DivIcon {
  return L.divIcon({ className: `pin ${cls}`, iconSize: [16, 16], iconAnchor: [8, 8] });
}

/** Small, non-interactive route preview above the quote list. */
export class RoutePreview {
  private map: L.Map;
  private layer = L.layerGroup();

  constructor(el: HTMLElement) {
    this.map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
    });
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(this.map);
    this.layer.addTo(this.map);
    this.map.attributionControl.setPrefix(false);
  }

  show(from: Place, to: Place, route: Route | null): void {
    this.map.invalidateSize();
    this.layer.clearLayers();
    const line: L.LatLngExpression[] = route?.geometry ?? [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ];
    L.polyline(line, {
      // Stroke colour comes from CSS so it follows the light/dark theme.
      className: 'route-line',
      weight: 5,
      opacity: 0.9,
      dashArray: route?.geometry ? undefined : '6 8',
    }).addTo(this.layer);
    L.marker([from.lat, from.lng], { icon: dot('pin-from'), interactive: false }).addTo(this.layer);
    L.marker([to.lat, to.lng], { icon: dot('pin-to'), interactive: false }).addTo(this.layer);
    this.map.fitBounds(L.latLngBounds(line), { padding: [22, 22], maxZoom: 16 });
  }
}

/** Full-screen map with a fixed centre pin; resolves with the chosen point. */
export function pickOnMap(el: HTMLElement, center: { lat: number; lng: number }): { map: L.Map; getCenter: () => { lat: number; lng: number } } {
  const map = L.map(el, { zoomControl: false }).setView([center.lat, center.lng], 16);
  L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
  map.attributionControl.setPrefix(false);
  requestAnimationFrame(() => map.invalidateSize());
  return {
    map,
    getCenter: () => {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    },
  };
}

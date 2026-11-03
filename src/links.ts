import type { LatLng, Vehicle } from './route';

const ll = (p: LatLng) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
const TRAVEL_MODE: Record<Vehicle, string> = { moto: 'two-wheeler', car: 'driving', bike: 'bicycling' };

/**
 * Google Maps directions link. Origin is left out so Maps starts from the live GPS position.
 * Google Maps on phones accepts at most 3 waypoints.
 */
export function googleMapsUrl(waypoints: LatLng[], finish: LatLng, vehicle: Vehicle) {
  const params = [
    'api=1',
    `destination=${encodeURIComponent(ll(finish))}`,
    `travelmode=${TRAVEL_MODE[vehicle]}`,
    'dir_action=navigate',
  ];
  if (waypoints.length) params.push(`waypoints=${encodeURIComponent(waypoints.slice(0, 3).map(ll).join('|'))}`);
  return `https://www.google.com/maps/dir/?${params.join('&')}`;
}

/** Waze only takes one destination, so each leg gets its own link. */
export function wazeUrl(p: LatLng) {
  return `https://waze.com/ul?ll=${encodeURIComponent(ll(p))}&navigate=yes`;
}

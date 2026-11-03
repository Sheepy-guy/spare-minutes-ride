import { choosePlaces, fetchPlaces, fetchWithTimeout, WeightedPlace } from './places';

export type LatLng = { latitude: number; longitude: number };
export type Vehicle = 'moto' | 'car' | 'bike';
export type Mode = 'loop' | 'out' | 'pick';
export type Direction = 'Any' | 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export const DIRECTIONS: Direction[] = ['Any', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const BEARING: Record<Exclude<Direction, 'Any'>, number> = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315,
};

// Typical average speed (km/h) including lights and traffic.
export const SPEED_KMH: Record<Vehicle, number> = { moto: 35, car: 30, bike: 16 };

// Roads wander: real distance is roughly this much longer than a straight line.
const ROAD_FACTOR = 1.35;
const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function move(p: LatLng, bearingDeg: number, km: number): LatLng {
  const b = rad(bearingDeg);
  const d = km / EARTH_KM;
  const la = rad(p.latitude);
  const lo = rad(p.longitude);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { latitude: deg(la2), longitude: ((deg(lo2) + 540) % 360) - 180 };
}

export function targetKm(minutes: number, vehicle: Vehicle) {
  return (minutes / 60) * SPEED_KMH[vehicle];
}

// Small seeded RNG so "scale and retry" keeps the same route shape.
function rng(seed: number) {
  let s = Math.floor(seed * 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Waypoints (excluding start/finish) for a loop or an out-and-back ride. */
export function generateWaypoints(
  start: LatLng,
  mode: Exclude<Mode, 'pick'>,
  km: number,
  direction: Direction,
  seed: number,
  scale = 1,
): LatLng[] {
  const rand = rng(seed);
  const straight = (km / ROAD_FACTOR) * scale;
  const bearing = direction === 'Any' ? rand() * 360 : BEARING[direction] + (rand() - 0.5) * 30;

  if (mode === 'out') return [move(start, bearing, straight / 2)];

  // Loop: start sits on a circle; drop 3 points around it.
  const r = straight / (2 * Math.PI);
  const center = move(start, bearing, r);
  const startAngle = (bearing + 180) % 360;
  const dir = rand() < 0.5 ? 1 : -1;
  const pts: LatLng[] = [];
  for (let k = 1; k <= 3; k++) {
    const a = startAngle + dir * (k * 90 + (rand() - 0.5) * 30);
    pts.push(move(center, a, r * (0.85 + rand() * 0.3)));
  }
  return pts;
}

export type RoadRoute = {
  coords: LatLng[];
  km: number;
  snapped: LatLng[]; // each input point moved onto the nearest road
};

/** A stop on the ride. `kind` is null for a plain road point (no public place nearby). */
export type Stop = LatLng & { name: string; kind: string | null };

// Free OpenStreetMap routing (FOSSGIS). Fine for personal use; swap for your own server or a paid API at scale.
const OSRM_BASE: Record<Vehicle, string> = {
  moto: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
  car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/',
};

export async function fetchRoadRoute(points: LatLng[], vehicle: Vehicle, signal?: AbortSignal): Promise<RoadRoute> {
  const path = points.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';');
  const res = await fetchWithTimeout(`${OSRM_BASE[vehicle]}${path}?overview=full&geometries=geojson`, {}, 15000, signal);
  if (!res.ok) throw new Error(`Routing failed (${res.status})`);
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(json.message || 'No road route found');
  const route = json.routes[0];
  return {
    coords: route.geometry.coordinates.map(([lng, lat]: [number, number]) => ({ latitude: lat, longitude: lng })),
    km: route.distance / 1000,
    snapped: json.waypoints.map((w: { location: [number, number] }) => ({ latitude: w.location[1], longitude: w.location[0] })),
  };
}

export type RidePlan = { stops: Stop[]; road: RoadRoute | null; placesFailed: boolean };

/**
 * Build a ride through public places (petrol stations, parks, malls...) placed along the ride shape,
 * then fit it to roads. If the road distance is far off the target, resize the shape and try again.
 */
export async function planRide(opts: {
  start: LatLng;
  finish: LatLng | null;
  mode: Exclude<Mode, 'pick'>;
  minutes: number;
  vehicle: Vehicle;
  direction: Direction;
  seed: number;
  signal?: AbortSignal;
}): Promise<RidePlan> {
  const km = targetKm(opts.minutes, opts.vehicle);
  const straight = km / ROAD_FACTOR;
  // Far enough to cover the shape even after it is scaled up.
  const reachKm = opts.mode === 'loop' ? straight / Math.PI : straight / 2;
  const searchKm = Math.min(25, reachKm * 1.6 + 1);

  let places: WeightedPlace[] = [];
  let placesFailed = false;
  try {
    places = await fetchPlaces(opts.start, searchKm, opts.signal);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    placesFailed = true;
  }

  let scale = 1;
  let best: RidePlan | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ideals = generateWaypoints(opts.start, opts.mode, km, opts.direction, opts.seed, scale);
    const size = opts.mode === 'loop' ? (straight * scale) / (2 * Math.PI) : (straight * scale) / 2;
    const picks = choosePlaces(ideals, places, opts.start, {
      maxOffKm: Math.max(0.5, size * 0.6),
      minFromStartKm: size * 0.4,
      rand: rng((opts.seed * 7.31) % 1),
    });
    let stops: Stop[] = ideals.map((p, i) => picks[i] ?? { ...p, name: '', kind: null });

    let road: RoadRoute;
    try {
      road = await fetchRoadRoute([opts.start, ...stops, opts.finish ?? opts.start], opts.vehicle, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      return best ?? { stops, road: null, placesFailed }; // offline: still usable, the nav app routes it
    }
    // Plain road points move onto the road itself; real places keep their own position.
    stops = stops.map((s, i) => (s.kind ? s : { ...s, ...road.snapped[i + 1] }));

    const candidate = { stops, road, placesFailed };
    if (!best || Math.abs(road.km - km) < Math.abs(best.road!.km - km)) best = candidate;
    const ratio = road.km / km;
    if (ratio > 0.8 && ratio < 1.25) break;
    scale *= km / road.km;
  }
  return best!;
}

import type { LatLng } from './route';

/** A public spot a ride can pass through. */
export type Place = LatLng & { name: string; kind: string };

// Public, easy-to-stop-at places. Lower weight = preferred when choosing between nearby options.
// Petrol stations and malls sit on main roads, so they keep the ride off small residential lanes.
const KINDS: { tag: string; values: string[]; label: Record<string, string>; weight: number }[] = [
  { tag: 'amenity', values: ['fuel'], label: { fuel: 'Petrol station' }, weight: 1 },
  { tag: 'shop', values: ['mall'], label: { mall: 'Mall' }, weight: 1 },
  { tag: 'tourism', values: ['viewpoint', 'attraction', 'museum'], label: { viewpoint: 'Viewpoint', attraction: 'Attraction', museum: 'Museum' }, weight: 1 },
  { tag: 'leisure', values: ['park'], label: { park: 'Park' }, weight: 1.1 },
  { tag: 'amenity', values: ['cafe', 'fast_food', 'marketplace'], label: { cafe: 'Café', fast_food: 'Food', marketplace: 'Market' }, weight: 1.25 },
];

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function overpassQuery(c: LatLng, radiusM: number) {
  const around = `(around:${Math.round(radiusM)},${c.latitude.toFixed(5)},${c.longitude.toFixed(5)})`;
  const parts = KINDS.map((k) => `nwr["${k.tag}"~"^(${k.values.join('|')})$"]["name"]${around};`).join('');
  return `[out:json][timeout:20];(${parts});out center 1500;`;
}

type OsmElement = {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function toPlace(el: OsmElement): (Place & { weight: number }) | null {
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const tags = el.tags ?? {};
  if (lat == null || lon == null || !tags.name) return null;
  for (const k of KINDS) {
    const v = tags[k.tag];
    if (v && k.values.includes(v)) {
      return { latitude: lat, longitude: lon, name: tags['name:en'] || tags.name, kind: k.label[v], weight: k.weight };
    }
  }
  return null;
}

export type WeightedPlace = Place & { weight: number };

// Reuse the last answer while the rider stays put, so Shuffle doesn't hit the server every time.
let cache: { center: LatLng; radiusKm: number; places: WeightedPlace[] } | null = null;

export async function fetchPlaces(center: LatLng, radiusKm: number, signal?: AbortSignal): Promise<WeightedPlace[]> {
  if (cache && cache.radiusKm >= radiusKm && distanceKm(cache.center, center) < 0.3) return cache.places;
  const body = 'data=' + encodeURIComponent(overpassQuery(center, radiusKm * 1000));
  let lastError: unknown;
  for (const url of OVERPASS) {
    try {
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
        25000,
        signal,
      );
      if (!res.ok) throw new Error(`Places lookup failed (${res.status})`);
      const json = await res.json();
      const places = (json.elements as OsmElement[]).map(toPlace).filter((p): p is WeightedPlace => !!p);
      cache = { center, radiusKm, places };
      return places;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

export function distanceKm(a: LatLng, b: LatLng) {
  const kx = 111.32 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot((a.latitude - b.latitude) * 110.57, (a.longitude - b.longitude) * kx);
}

/**
 * For each ideal point on the ride shape, pick a nearby public place.
 * Picks randomly among the 3 best so Shuffle gives variety. Returns null where nothing fits.
 */
export function choosePlaces(
  ideals: LatLng[],
  candidates: WeightedPlace[],
  start: LatLng,
  opts: { maxOffKm: number; minFromStartKm: number; rand: () => number },
): (Place | null)[] {
  const used: Place[] = [];
  return ideals.map((ideal) => {
    const nearby = candidates
      .filter((c) => distanceKm(c, start) >= opts.minFromStartKm)
      .filter((c) => used.every((u) => distanceKm(u, c) > 0.4))
      .map((c) => ({ c, off: distanceKm(c, ideal) }));
    // Prefer places close to the ride shape; in quieter areas accept ones a bit further off.
    let options = nearby.filter((o) => o.off <= opts.maxOffKm);
    if (!options.length) options = nearby.filter((o) => o.off <= opts.maxOffKm * 1.75);
    options = options.sort((a, b) => a.off * a.c.weight - b.off * b.c.weight).slice(0, 3);
    if (!options.length) return null;
    const pick = options[Math.floor(opts.rand() * options.length)].c;
    used.push(pick);
    return { latitude: pick.latitude, longitude: pick.longitude, name: pick.name, kind: pick.kind };
  });
}

/** fetch() that gives up after `ms`, and also stops when the outer signal aborts. */
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number, outer?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

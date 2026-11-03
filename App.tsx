import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { LongPressEvent, MapPressEvent, MapViewProps, Marker, Polyline } from 'react-native-maps';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { googleMapsUrl, wazeUrl } from './src/links';
import {
  DIRECTIONS,
  Direction,
  LatLng,
  Mode,
  RoadRoute,
  SPEED_KMH,
  Stop,
  Vehicle,
  fetchRoadRoute,
  planRide,
  targetKm,
} from './src/route';

type PoiClickEvent = Parameters<NonNullable<MapViewProps['onPoiClick']>>[0];

const MINUTE_CHOICES = [10, 15, 20, 30, 45, 60];
const VEHICLES: { key: Vehicle; label: string }[] = [
  { key: 'moto', label: 'Motorbike' },
  { key: 'car', label: 'Car' },
  { key: 'bike', label: 'Bicycle' },
];
const MODES: { key: Mode; label: string }[] = [
  { key: 'loop', label: 'Random loop' },
  { key: 'out', label: 'Out & back' },
  { key: 'pick', label: 'Pick stops' },
];

const C = {
  asphalt: '#22262b',
  panel: '#ffffff',
  line: '#dde1e6',
  muted: '#5d6670',
  fg: '#1d2126',
  amber: '#e5a00d',
  gmaps: '#1a73e8',
  waze: '#0b8fbf',
};

export default function App() {
  return (
    <SafeAreaProvider>
      <RideScreen />
    </SafeAreaProvider>
  );
}

function RideScreen() {
  const mapRef = useRef<MapView>(null);
  const [start, setStart] = useState<LatLng | null>(null);
  const [locError, setLocError] = useState<string | null>(null);
  const [finish, setFinish] = useState<LatLng | null>(null);

  const [mode, setMode] = useState<Mode>('loop');
  const [minutes, setMinutes] = useState(20);
  const [vehicle, setVehicle] = useState<Vehicle>('moto');
  const [direction, setDirection] = useState<Direction>('Any');
  const [seed, setSeed] = useState(Math.random());

  const [stops, setStops] = useState<Stop[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [road, setRoad] = useState<RoadRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  const locate = useCallback(async () => {
    setLocError(null);
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setLocError('Location is off. Allow it in Settings, or tap "Start at map centre".');
      return;
    }
    const last = await Location.getLastKnownPositionAsync();
    if (last) setStart({ latitude: last.coords.latitude, longitude: last.coords.longitude });
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    setStart({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
  }, []);

  useEffect(() => {
    locate().catch((e) => setLocError(String(e.message ?? e)));
  }, [locate]);

  // Build the ride whenever an input changes.
  useEffect(() => {
    if (!start) return;
    const ctrl = new AbortController();
    const cleanup = () => {
      ctrl.abort();
      setLoading(false);
    };
    setRouteError(null);
    setNote(null);

    if (mode === 'pick') {
      setRoad(null);
      if (!stops.length) {
        setLoading(false);
        return;
      }
      setLoading(true);
      fetchRoadRoute([start, ...stops, finish ?? start], vehicle, ctrl.signal)
        .then(setRoad)
        .catch((e) => !ctrl.signal.aborted && setRouteError(e.message))
        .finally(() => !ctrl.signal.aborted && setLoading(false));
      return cleanup;
    }

    setLoading(true);
    planRide({ start, finish, mode, minutes, vehicle, direction, seed, signal: ctrl.signal })
      .then(({ stops, road, placesFailed }) => {
        setStops(stops);
        setRoad(road);
        if (!road) setRouteError('Could not load the road preview. Google Maps or Waze will still route it.');
        if (placesFailed) setNote('Could not load public places, so stops are plain road points. Check them before you go.');
        else if (stops.some((s) => !s.kind)) setNote('No public place near some stops, so they are road points. Shuffle for others.');
      })
      .catch((e) => !ctrl.signal.aborted && setRouteError(e.message))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return cleanup;
    // stops is an output in loop/out modes, an input only in pick mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, finish, mode, minutes, vehicle, direction, seed, mode === 'pick' ? stops : null]);

  // Give road points and tapped pins a street name so you know where you're heading.
  useEffect(() => {
    const unnamed = stops.filter((s) => !s.name);
    if (!unnamed.length) return;
    let cancelled = false;
    Promise.all(
      stops.map(async (s) => {
        if (s.name) return s;
        try {
          const [a] = await Location.reverseGeocodeAsync(s);
          const name = a?.street || a?.name || a?.district || a?.subregion;
          return { ...s, name: name ? `Near ${name}` : 'Road point' };
        } catch {
          return { ...s, name: 'Road point' };
        }
      }),
    ).then((named) => !cancelled && setStops((cur) => (cur === stops ? named : cur)));
    return () => {
      cancelled = true;
    };
  }, [stops]);

  // Keep the whole ride in view.
  useEffect(() => {
    const pts = road?.coords ?? (start ? [start, ...stops, ...(finish ? [finish] : [])] : []);
    if (pts.length > 1) {
      mapRef.current?.fitToCoordinates(pts, {
        edgePadding: { top: 60, right: 40, bottom: 40, left: 40 },
        animated: true,
      });
    }
  }, [road, start, stops, finish]);

  const onMapPress = (e: MapPressEvent) => {
    if (mode !== 'pick' || e.nativeEvent.action === 'marker-press') return;
    const c = e.nativeEvent.coordinate;
    setStops((s) => (s.length >= 3 ? s : [...s, { ...c, name: '', kind: null }]));
  };
  // Tapping a named place on the map (shop, park...) adds it with its real name.
  const onPoiClick = (e: PoiClickEvent) => {
    if (mode !== 'pick') return;
    const { coordinate, name } = e.nativeEvent;
    setStops((s) => (s.length >= 3 ? s : [...s, { ...coordinate, name: name.replace(/\n/g, ' '), kind: 'Place' }]));
  };
  const showOnMap = (p: LatLng) =>
    mapRef.current?.animateToRegion({ ...p, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 400);
  const onLongPress = (e: LongPressEvent) => setFinish(e.nativeEvent.coordinate);

  const startAtMapCentre = async () => {
    const cam = await mapRef.current?.getCamera();
    if (cam) {
      setLocError(null);
      setStart(cam.center);
    }
  };

  const changeMode = (m: Mode) => {
    setMode(m);
    setStops([]);
    setRoad(null);
  };

  const end = finish ?? start;
  const ready = !!start && !!end && (mode !== 'pick' || stops.length > 0);
  const km = road?.km ?? (mode === 'pick' ? null : targetKm(minutes, vehicle));
  const estMin = km != null ? Math.round((km / SPEED_KMH[vehicle]) * 60) : null;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <MapView
        ref={mapRef}
        style={styles.map}
        showsUserLocation
        showsMyLocationButton={false}
        initialRegion={{ latitude: 3.1554, longitude: 101.7145, latitudeDelta: 0.08, longitudeDelta: 0.08 }}
        onPress={onMapPress}
        onLongPress={onLongPress}
        onPoiClick={onPoiClick}
      >
        {road ? (
          <Polyline coordinates={road.coords} strokeColor={C.amber} strokeWidth={6} />
        ) : start && stops.length ? (
          <Polyline
            coordinates={[start, ...stops, end!]}
            strokeColor={C.amber}
            strokeWidth={4}
            lineDashPattern={[10, 8]}
          />
        ) : null}
        {stops.map((s, i) => (
          <Marker
            key={`${i}-${s.latitude}`}
            coordinate={s}
            anchor={{ x: 0.5, y: 0.5 }}
            title={s.name || `Stop ${i + 1}`}
            description={s.kind ?? 'Road point'}
            onPress={() => mode === 'pick' && setStops((all) => all.filter((_, j) => j !== i))}
          >
            <View style={styles.stopPin}>
              <Text style={styles.stopPinText}>{i + 1}</Text>
            </View>
          </Marker>
        ))}
        {finish && (
          <Marker coordinate={finish} anchor={{ x: 0.5, y: 0.5 }} onPress={() => setFinish(null)}>
            <View style={styles.finishPin}>
              <Text style={styles.finishPinText}>END</Text>
            </View>
          </Marker>
        )}
      </MapView>

      <SafeAreaView edges={['top']} style={styles.topBar} pointerEvents="box-none">
        <View style={styles.banner}>
          <Text style={styles.title}>SPARE MINUTES RIDE</Text>
          <Text style={styles.bannerText}>
            {mode === 'pick'
              ? 'Tap places on the map to add up to 3 stops. Tap a stop to remove it.'
              : 'Long-press the map to finish somewhere else. Tap END to clear it.'}
          </Text>
        </View>
        {loading && <ActivityIndicator style={styles.spinner} color={C.amber} />}
      </SafeAreaView>

      <SafeAreaView edges={['bottom']} style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.sheetContent}>
          {locError && (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{locError}</Text>
              <View style={styles.row}>
                <Chip label="Try again" onPress={() => locate().catch(() => {})} />
                <Chip label="Start at map centre" onPress={startAtMapCentre} />
              </View>
            </View>
          )}

          <Segmented options={MODES} value={mode} onChange={changeMode} />

          {mode !== 'pick' && (
            <>
              <Label>Time to kill</Label>
              <View style={styles.row}>
                {MINUTE_CHOICES.map((m) => (
                  <Chip key={m} label={`${m} min`} active={minutes === m} onPress={() => setMinutes(m)} />
                ))}
              </View>
              <Label>Head towards</Label>
              <View style={styles.row}>
                {DIRECTIONS.map((d) => (
                  <Chip key={d} label={d} active={direction === d} onPress={() => setDirection(d)} small />
                ))}
              </View>
            </>
          )}

          <Label>Riding</Label>
          <Segmented options={VEHICLES} value={vehicle} onChange={setVehicle} />

          <View style={styles.stats}>
            <Stat value={km != null ? km.toFixed(1) : '–'} label={road ? 'km on roads' : 'km (est.)'} />
            <Stat value={estMin != null ? String(estMin) : '–'} label="minutes" />
            <Stat value={String(stops.length)} label="stops" />
          </View>
          {routeError && <Text style={styles.error}>{routeError}</Text>}

          {ready && (
            <>
              <Label>Where you'll go</Label>
              <View style={styles.stopList}>
                {[...stops.map((s, i) => ({ p: s as LatLng, n: String(i + 1), title: s.name || 'Finding name…', sub: s.kind ?? 'Road point' })),
                  { p: end!, n: finish ? 'END' : '↩', title: finish ? 'Your finish point' : 'Back to start', sub: 'Finish' },
                ].map((row, i) => (
                  <Pressable key={i} style={styles.stopRow} onPress={() => showOnMap(row.p)}>
                    <View style={styles.stopBadge}>
                      <Text style={styles.stopBadgeText}>{row.n}</Text>
                    </View>
                    <View style={styles.stopInfo}>
                      <Text style={styles.stopName} numberOfLines={1}>{row.title}</Text>
                      <Text style={[styles.stopKind, row.sub === 'Road point' && styles.stopKindWarn]}>{row.sub}</Text>
                    </View>
                    <Pressable style={styles.wazeBtn} onPress={() => Linking.openURL(wazeUrl(row.p))} hitSlop={6}>
                      <Text style={styles.wazeLegText}>Waze</Text>
                    </Pressable>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.hint}>Tap a stop to see it on the map. Waze takes one stop at a time.</Text>
            </>
          )}
          {note && <Text style={styles.noteText}>{note}</Text>}

          {mode !== 'pick' && (
            <Pressable style={styles.shuffle} onPress={() => setSeed(Math.random())}>
              <Text style={styles.shuffleText}>↻  Shuffle route</Text>
            </Pressable>
          )}

          <Pressable
            disabled={!ready}
            style={[styles.go, { backgroundColor: C.gmaps, opacity: ready ? 1 : 0.4 }]}
            onPress={() => Linking.openURL(googleMapsUrl(stops, end!, vehicle))}
          >
            <Text style={styles.goText}>Ride it in Google Maps</Text>
          </Pressable>

        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Label({ children }: { children: string }) {
  return <Text style={styles.label}>{children.toUpperCase()}</Text>;
}

function Chip({ label, active, onPress, small }: { label: string; active?: boolean; onPress: () => void; small?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, small && styles.chipSmall, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable key={o.key} onPress={() => onChange(o.key)} style={[styles.seg, value === o.key && styles.segActive]}>
          <Text style={[styles.segText, value === o.key && styles.segTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.asphalt },
  map: { flex: 1 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12 },
  banner: { marginTop: 8, backgroundColor: C.asphalt, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  title: { color: C.amber, fontWeight: '800', letterSpacing: 1.5, fontSize: 13 },
  bannerText: { color: '#e8eaed', fontSize: 13, marginTop: 2 },
  spinner: { marginTop: 10, alignSelf: 'center' },
  sheet: {
    maxHeight: '52%',
    backgroundColor: C.panel,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  sheetContent: { padding: 16, gap: 10 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 1, color: C.muted, marginTop: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  chipSmall: { paddingHorizontal: 10, paddingVertical: 6 },
  chipActive: { backgroundColor: C.asphalt, borderColor: C.asphalt },
  chipText: { color: C.fg, fontSize: 14 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  segmented: { flexDirection: 'row', backgroundColor: '#eef0f2', borderRadius: 10, padding: 3 },
  seg: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  segActive: { backgroundColor: C.asphalt },
  segText: { color: C.fg, fontSize: 14, fontWeight: '500' },
  segTextActive: { color: '#fff' },
  stats: { flexDirection: 'row', borderWidth: 1, borderColor: C.line, borderRadius: 10, marginTop: 4 },
  stat: { flex: 1, padding: 10 },
  statValue: { fontSize: 24, fontWeight: '800', color: C.fg, fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 10, color: C.muted, letterSpacing: 0.8 },
  error: { color: '#b3261e', fontSize: 13 },
  notice: { backgroundColor: '#fff4dc', borderRadius: 10, padding: 12, gap: 8 },
  noticeText: { color: C.fg, fontSize: 13 },
  shuffle: { borderWidth: 1.5, borderColor: C.fg, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  shuffleText: { fontWeight: '700', fontSize: 15, color: C.fg },
  go: { borderRadius: 10, paddingVertical: 15, alignItems: 'center' },
  goText: { color: '#fff', fontWeight: '800', fontSize: 16, letterSpacing: 0.5 },
  stopList: { borderWidth: 1, borderColor: C.line, borderRadius: 10 },
  stopRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  stopBadge: { minWidth: 30, height: 30, borderRadius: 15, paddingHorizontal: 4, backgroundColor: C.asphalt, alignItems: 'center', justifyContent: 'center' },
  stopBadgeText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  stopInfo: { flex: 1, minWidth: 0 },
  stopName: { color: C.fg, fontWeight: '600', fontSize: 14 },
  stopKind: { color: C.muted, fontSize: 12 },
  stopKindWarn: { color: '#a15c00' },
  wazeBtn: { borderWidth: 1.5, borderColor: C.waze, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  hint: { color: C.muted, fontSize: 12 },
  noteText: { color: '#a15c00', fontSize: 13 },
  wazeLegText: { color: C.waze, fontWeight: '700' },
  stopPin: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: '#fff',
    borderWidth: 3, borderColor: C.asphalt, alignItems: 'center', justifyContent: 'center',
  },
  stopPinText: { fontWeight: '800', color: C.asphalt },
  finishPin: { backgroundColor: C.asphalt, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 2, borderColor: C.amber },
  finishPinText: { color: C.amber, fontWeight: '800', fontSize: 12 },
});

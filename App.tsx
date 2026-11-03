import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { LongPressEvent, MapPressEvent, Marker, Polyline } from 'react-native-maps';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { googleMapsUrl, wazeUrl } from './src/links';
import {
  DIRECTIONS,
  Direction,
  LatLng,
  Mode,
  RoadRoute,
  SPEED_KMH,
  Vehicle,
  fetchRoadRoute,
  planRide,
  targetKm,
} from './src/route';

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

  const [stops, setStops] = useState<LatLng[]>([]);
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
    setRouteError(null);

    if (mode === 'pick') {
      setRoad(null);
      if (!stops.length) return;
      setLoading(true);
      fetchRoadRoute([start, ...stops, finish ?? start], vehicle, ctrl.signal)
        .then(setRoad)
        .catch((e) => !ctrl.signal.aborted && setRouteError(e.message))
        .finally(() => !ctrl.signal.aborted && setLoading(false));
      return () => ctrl.abort();
    }

    setLoading(true);
    planRide({ start, finish, mode, minutes, vehicle, direction, seed, signal: ctrl.signal })
      .then(({ waypoints, road }) => {
        setStops(waypoints);
        setRoad(road);
        if (!road) setRouteError('No internet for the road preview. The nav app will still route it.');
      })
      .catch((e) => !ctrl.signal.aborted && setRouteError(e.message))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // stops is an output in loop/out modes, an input only in pick mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, finish, mode, minutes, vehicle, direction, seed, mode === 'pick' ? stops : null]);

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
    setStops((s) => (s.length >= 3 ? s : [...s, c]));
  };
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
              ? 'Tap the map to add up to 3 stops. Tap a stop to remove it.'
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

          <Label>Waze, one leg at a time</Label>
          <View style={styles.row}>
            {ready &&
              [...stops, end!].map((p, i) => (
                <Pressable key={i} style={styles.wazeLeg} onPress={() => Linking.openURL(wazeUrl(p))}>
                  <Text style={styles.wazeLegText}>
                    {i < stops.length ? `Stop ${i + 1}` : finish ? 'Finish' : 'Back to start'}
                  </Text>
                </Pressable>
              ))}
          </View>
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
  wazeLeg: { borderWidth: 1.5, borderColor: C.waze, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14 },
  wazeLegText: { color: C.waze, fontWeight: '700' },
  stopPin: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: '#fff',
    borderWidth: 3, borderColor: C.asphalt, alignItems: 'center', justifyContent: 'center',
  },
  stopPinText: { fontWeight: '800', color: C.asphalt },
  finishPin: { backgroundColor: C.asphalt, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 2, borderColor: C.amber },
  finishPinText: { color: C.amber, fontWeight: '800', fontSize: 12 },
});

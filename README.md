# Spare Minutes Ride

Got somewhere early? Pick how many minutes you have, get a riding loop on real roads, then hand it to Google Maps or Waze.

## Features
- **Random loop** – 3 stops around you, sized to your spare time, starting and ending at your GPS position.
- **Out & back** – ride out in a chosen direction (or any) and return.
- **Pick stops** – tap the map to choose up to 3 stops yourself.
- **Finish elsewhere** – long-press the map to end the ride at your appointment.
- Route is snapped to real roads (OpenStreetMap routing) and resized until the distance fits your time.
- **Google Maps**: whole route in one tap. **Waze**: one button per leg (Waze links take a single destination).

## Run it on your phone
1. Install **Expo Go** from the App Store / Play Store.
2. On your computer: `npm install` then `npx expo start`.
3. Scan the QR code (Camera app on iPhone, Expo Go on Android).

## Code
- `App.tsx` – screen, map and controls
- `src/route.ts` – loop geometry, road routing, distance fitting
- `src/links.ts` – Google Maps and Waze deep links

## Notes
- Google Maps on phones accepts at most 3 waypoints, so loops use 3 stops.
- Road routing uses the free FOSSGIS OSRM servers at routing.openstreetmap.de. Fine for personal use; switch to your own server or a paid API before publishing.
- Speeds per vehicle are in `SPEED_KMH` in `src/route.ts`.
